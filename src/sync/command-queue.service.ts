/**
 * Command Queue Service.
 *
 * Durable SQLite outbox for commands that cannot be executed immediately.
 * Responsibilities:
 *   - Persist commands when the cloud and Local Node are both unavailable.
 *   - Generate local order numbers for offline `order:create` commands.
 *   - Replay queued commands when a transport becomes available.
 *   - Provide optimistic domain events so the UI can render pending orders.
 */

import type { Command, DomainEvent, PersistedCommand } from "./types";
import type { SellerOrder } from "../types/api/seller.api";
import { getSyncDatabase, openSyncDatabase } from "../db/connection";
import {
  insertCommand,
  getPendingCommands,
  markCommandInFlight,
  updateCommandStatus,
  deleteCommand,
  insertEvent,
} from "../db/operations";
import { syncLogger } from "../utils/sync-logger";
import { generateEventId } from "../utils/uuid";
import {
  generateLocalOrderNumber,
  generateLocalCalloutNumber,
} from "./order-number";
import type { SyncEngine } from "./engine";

const MAX_RETRIES = 5;

function buildOptimisticEvent(command: Command): DomainEvent {
  const payload = command.payload as Record<string, unknown>;
  return {
    event_id: generateEventId(),
    event_type: `${command.command_type.replace(":", ".")}_queued`,
    event_version: "1.0",
    entity_id: command.entity_id ?? command.command_id,
    user_id: command.user_id,
    device_id: command.device_id,
    payload:
      command.command_type === "order:create"
        ? buildOptimisticOrder(command, payload)
        : {
            ...payload,
            command_id: command.command_id,
            status: "pending",
          },
    timestamp: new Date().toISOString(),
  };
}

function buildOptimisticOrder(
  command: Command,
  payload: Record<string, unknown>,
): SellerOrder {
  const items = (payload.items as Array<{ menu_item_id: string; quantity: number }>) ?? [];
  const totalMinor = (payload.total_minor as number) ?? 0;
  const now = new Date().toISOString();

  const orderNumber =
    (payload.order_number as string) ?? generateLocalOrderNumber();

  return {
    id: (command.entity_id as string) ?? command.command_id,
    order_number: orderNumber,
    callout_number: generateLocalCalloutNumber(),
    order_type: (payload.order_type as string) ?? "takeout",
    is_pos: true,
    customer_name: (payload.customer_name as string) ?? null,
    customer_phone: (payload.customer_phone as string) ?? null,
    pos_payment_method: (payload.pos_payment_method as string) ?? "cash",
    paid_at: null,
    status: "pending",
    delivery_id: null,
    delivery_status: null,
    is_paid: (payload.pos_payment_method as string) === "cash",
    payment: {
      is_paid: (payload.pos_payment_method as string) === "cash",
      reference: null,
      amount_minor: totalMinor,
      currency: "GHS",
      paid_at: (payload.pos_payment_method as string) === "cash" ? now : null,
    },
    payment_mode: "pos_cash",
    total_minor: totalMinor,
    subtotal_minor: totalMinor,
    delivery_fee_minor: 0,
    tax_minor: 0,
    tip_minor: null,
    discount_minor: 0,
    promo_code: null,
    tax_lines: [],
    currency: "GHS",
    currency_code: "GHS",
    business_id: command.business_id,
    business: null,
    delivery_address: null,
    delivery_lat: null,
    delivery_lng: null,
    user: null,
    items: items.map((item, index) => ({
      id: `tmp-${command.command_id}-${index}`,
      menu_item: { id: item.menu_item_id, name: "" },
      quantity: item.quantity,
      unit_price: 0,
      subtotal: 0,
      addons: [],
    })),
    inserted_at: now,
  };
}

/**
 * If a command creates an order and we are offline, inject a local order number
 * into the payload so the UI and receipt printers have a stable identifier.
 */
function injectLocalOrderNumber(command: Command): Command {
  if (command.command_type !== "order:create") return command;

  const payload = command.payload as Record<string, unknown>;
  if (payload.order_number) return command;

  return {
    ...command,
    payload: {
      ...payload,
      order_number: generateLocalOrderNumber(),
    },
  };
}

class CommandQueueService {
  private replaying = false;
  private syncEngine: SyncEngine | null = null;

  setSyncEngine(engine: SyncEngine): void {
    this.syncEngine = engine;
  }

  /**
   * Enqueue a command because no transport is currently available.
   * Returns an optimistic domain event so the caller can update the UI.
   */
  async enqueue(command: Command): Promise<DomainEvent> {
    const db = getSyncDatabase();
    const preparedCommand = injectLocalOrderNumber(command);
    await insertCommand(db, { command: preparedCommand, status: "pending" });
    syncLogger.command(preparedCommand, "queued");
    const pending = await getPendingCommands(db, Number.MAX_SAFE_INTEGER);
    syncLogger.info("CommandQueueService", "Command queued offline", {
      command_id: preparedCommand.command_id,
      command_type: preparedCommand.command_type,
      order_number: (preparedCommand.payload as Record<string, unknown>).order_number ?? null,
      outbox_size: pending.length,
    });
    const event = buildOptimisticEvent(preparedCommand);
    syncLogger.info("CommandQueueService", "Optimistic event built", {
      event_type: event.event_type,
      entity_id: event.entity_id,
      order_number: (event.payload as Record<string, unknown>).order_number ?? null,
      status: (event.payload as Record<string, unknown>).status,
    });

    // Persist the optimistic order so it survives app restarts and can be
    // rehydrated (and shown) while still offline.
    if (preparedCommand.command_type === "order:create") {
      try {
        await insertEvent(db, { event, origin: "local" });
      } catch (error) {
        syncLogger.error("CommandQueueService", "Failed to persist optimistic event", {
          error: String(error),
        });
      }
    }

    return event;
  }

  /**
   * Try to execute a single pending command through the current transport.
   */
  async processCommand(command: PersistedCommand): Promise<void> {
    const db = getSyncDatabase();
    const parsedCommand: Command = {
      command_id: command.command_id,
      command_type: command.command_type,
      command_version: command.command_version,
      business_id: command.business_id,
      entity_id: command.entity_id,
      user_id: command.user_id,
      device_id: command.device_id,
      timestamp: command.timestamp,
      payload: command.payload,
    };

    if (command.retry_count >= MAX_RETRIES) {
      await updateCommandStatus(
        db,
        command.command_id,
        "failed",
        "Max retry count exceeded",
      );
      return;
    }

    if (!this.syncEngine) {
      throw new Error("CommandQueueService: SyncEngine not initialized");
    }

    await markCommandInFlight(db, command.command_id);

    try {
      const events = await this.syncEngine.execute(parsedCommand);
      await updateCommandStatus(db, command.command_id, "completed");
      syncLogger.command(parsedCommand, "completed", {
        event_count: events.length,
      });
      syncLogger.info("CommandQueueService", "Queued command replayed", {
        command_id: command.command_id,
        command_type: command.command_type,
        event_count: events.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateCommandStatus(db, command.command_id, "failed", message);
      syncLogger.command(parsedCommand, "failed", { error: message });
      throw error;
    }
  }

  /**
   * Replay all pending commands in order. Stops on the first failure to keep
   * ordering consistent; the next replay will retry from the failed command.
   */
  async replay(): Promise<void> {
    if (this.replaying) {
      syncLogger.debug("CommandQueueService", "Replay already in progress");
      return;
    }

    this.replaying = true;
    try {
      // Await open (not getSyncDatabase) so a cold-start replay triggered by a
      // connectivity event that fires before the DB open completes does not
      // throw "Sync database not initialized".
      const db = await openSyncDatabase();
      const pending = await getPendingCommands(db);
      if (pending.length === 0) return;

      syncLogger.info("CommandQueueService", "Replaying commands", {
        count: pending.length,
      });

      for (const command of pending) {
        try {
          await this.processCommand(command);
        } catch {
          // Stop replay on first failure; retry will happen on next trigger.
          break;
        }
      }
    } finally {
      this.replaying = false;
    }
  }

  /**
   * Cancel a queued command that has not yet been transmitted.
   */
  async cancel(commandId: string): Promise<void> {
    const db = getSyncDatabase();
    await deleteCommand(db, commandId);
    syncLogger.debug("CommandQueueService", "Command cancelled", {
      commandId,
    });
  }

  /**
   * Return the number of commands currently in the outbox.
   */
  async getPendingCount(): Promise<number> {
    const db = getSyncDatabase();
    const commands = await getPendingCommands(db, Number.MAX_SAFE_INTEGER);
    return commands.length;
  }
}

export const commandQueueService = new CommandQueueService();
