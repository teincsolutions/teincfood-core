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
  generateLocalCalloutNumber,
  generateOrderNumberForBusiness,
  generateOrderNumber,
} from "./order-number";
import type { SyncEngine } from "./engine";
import { getConnectivityState, subscribeConnectivity } from "../adapters/connectivity";

const MAX_RETRIES = 5;

const QUEUED_STATUS_BY_COMMAND: Record<string, string> = {
  "order:accept": "accepted",
  "order:reject": "cancelled",
  "order:start_preparing": "preparing",
  "order:mark_ready": "ready",
  "order:complete_pickup": "delivered",
  "order:cancel": "cancelled",
  "delivery:assign": "assigned",
  "delivery:confirm_handover": "delivered",
};

const PAYMENT_QUEUED_PAYLOAD: Record<string, unknown> = {
  is_paid: true,
  to_is_paid: true,
};

export function getQueuedStatus(commandType: string): string | null {
  return QUEUED_STATUS_BY_COMMAND[commandType] ?? null;
}

function buildOptimisticEvent(command: Command): DomainEvent {
  const payload = command.payload as Record<string, unknown>;
  if (command.command_type === "order:create") {
    return {
      event_id: generateEventId(),
      event_type: `${command.command_type.replace(":", ".")}_queued`,
      event_version: "1.0",
      entity_id: command.entity_id ?? command.command_id,
      user_id: command.user_id,
      device_id: command.device_id,
      payload: buildOptimisticOrder(command, payload),
      timestamp: new Date().toISOString(),
    };
  }
  if (command.command_type === "payment:confirm_cash") {
    return {
      event_id: generateEventId(),
      event_type: "payment.completed_queued",
      event_version: "1.0",
      entity_id: command.entity_id ?? command.command_id,
      user_id: command.user_id,
      device_id: command.device_id,
      payload: {
        ...payload,
        command_id: command.command_id,
        is_paid: true,
        paid_at: new Date().toISOString(),
        order_id: command.entity_id,
      },
      timestamp: new Date().toISOString(),
    };
  }
  const queuedStatus = getQueuedStatus(command.command_type);
  return {
    event_id: generateEventId(),
    event_type: `${command.command_type.replace(":", ".")}_queued`,
    event_version: "1.0",
    entity_id: command.entity_id ?? command.command_id,
    user_id: command.user_id,
    device_id: command.device_id,
    payload: {
      ...payload,
      command_id: command.command_id,
      status: "pending",
      // Used by offline read-model patching so the list reflects the queued transition.
      to_status: queuedStatus,
      order_id: command.entity_id,
      delivery_id: command.entity_id,
      ...(queuedStatus ? {} : {}),
    },
    timestamp: new Date().toISOString(),
  };
}

function buildOptimisticOrder(
  command: Command,
  payload: Record<string, unknown>,
): SellerOrder {
  const snapshots = (payload.item_snapshots as Array<{ menu_item_id: string; name: string; quantity: number; unit_price_minor: number; variant_name?: string; addons?: Array<{ name: string; price_minor: number }> }>) ?? null;
  const items = (payload.items as Array<{ menu_item_id: string; quantity: number }>) ?? [];
  const totalMinor = (payload.total_minor as number) ?? 0;
  const subtotalMinor = (payload.subtotal_minor as number) ?? totalMinor;
  const taxMinor = (payload.tax_minor as number) ?? 0;
  const taxLines = (payload.tax_lines as unknown[]) ?? [];
  const currencyCode = (payload.currency_code as string) ?? "GHS";
  const now = new Date().toISOString();

  const orderNumber =
    (payload.order_number as string) ?? generateOrderNumberForBusiness(command.business_id);

  return {
    id: (command.entity_id as string) ?? command.command_id,
    order_number: orderNumber,
    callout_number: generateLocalCalloutNumber(command.business_id),
    order_type: (payload.order_type as string) ?? "takeout",
    is_pos: true,
    customer_name: (payload.customer_name as string) ?? null,
    customer_phone: (payload.customer_phone as string) ?? null,
    pos_payment_method: (payload.pos_payment_method as string) ?? "cash",
    paid_at: null,
    status: "accepted",
    delivery_id: null,
    delivery_status: null,
    is_paid: (payload.pos_payment_method as string) === "cash",
    payment: {
      is_paid: (payload.pos_payment_method as string) === "cash",
      reference: null,
      amount_minor: totalMinor,
      currency: currencyCode,
      paid_at: (payload.pos_payment_method as string) === "cash" ? now : null,
    },
    payment_mode: "pos_cash",
    total_minor: totalMinor,
    subtotal_minor: subtotalMinor,
    delivery_fee_minor: (payload.delivery_fee_minor as number) ?? 0,
    tax_minor: taxMinor,
    tip_minor: (payload.tip_minor as number) ?? null,
    discount_minor: (payload.discount_minor as number) ?? 0,
    promo_code: (payload.promo_code as string) ?? null,
    tax_lines: taxLines as SellerOrder["tax_lines"],
    currency: currencyCode,
    currency_code: currencyCode,
    business_id: command.business_id,
    business: null,
    delivery_address: null,
    delivery_lat: null,
    delivery_lng: null,
    user: null,
    items: (snapshots ? snapshots.map((s, index) => ({
      id: `tmp-${command.command_id}-${index}`,
      menu_item: { id: s.menu_item_id, name: s.name },
      quantity: s.quantity,
      unit_price: s.unit_price_minor,
      subtotal: s.unit_price_minor * s.quantity,
      variant_name: s.variant_name,
      addons: (s.addons ?? []).map((a) => ({ name: a.name, price_minor: a.price_minor })),
    })) : items.map((item, index) => ({
      id: `tmp-${command.command_id}-${index}`,
      menu_item: { id: item.menu_item_id, name: "" },
      quantity: item.quantity,
      unit_price: 0,
      subtotal: 0,
      addons: [],
    }))) as SellerOrder["items"],
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

  // 0.7.0: business-scoped DD-RRR-CCC; requires leased device_number
  const orderNumber = generateOrderNumberForBusiness(command.business_id);
  return {
    ...command,
    payload: {
      ...payload,
      order_number: orderNumber,
    },
  };
}

class CommandQueueService {
  private replaying: Promise<void> | null = null;
  private syncEngine: SyncEngine | null = null;

  setSyncEngine(engine: SyncEngine): void {
    this.syncEngine = engine;
    // Auto-replay when the cloud becomes reachable again (e.g. after a
    // timeout-induced `unreachable` flip, then the next successful probe sets
    // `reachable`). No polling — event-driven via connectivity state.
    try {
      subscribeConnectivity(() => {
        const s = getConnectivityState();
        if (s.isCloudReachable === "reachable" && s.isOnline) {
          this.replay().catch(() => {});
        }
      });
    } catch {}
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

    // Persist optimistic events so they survive restarts and can be
    // rehydrated offline. For order:create this is the full order; for
    // transitions it carries to_status so the read model can reflect the
    // queued status immediately.
    try {
      await insertEvent(db, { event, origin: "local" });
    } catch (error) {
      syncLogger.error("CommandQueueService", "Failed to persist optimistic event", {
        error: String(error),
      });
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
      // Outbox is an ephemeral queue — remove the row on success so the
      // Diagnostics outbox count drops to 0 and old completed rows never
      // accumulate. The optimistic event stays in `events` (marked synced).
      await deleteCommand(db, command.command_id);
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
      const apiErr = error as { status?: number; name?: string; code?: string; data?: unknown };
      // 409 ORDER_NUMBER_TAKEN is retryable once with new RRR
      const code = (apiErr as unknown as { code?: string })?.code ?? (apiErr?.data as unknown as { code?: string })?.code;
      if (apiErr?.status === 409 && String(code).includes("ORDER_NUMBER_TAKEN")) {
        if (command.command_type === "order:create") {
          try {
            const payload = command.payload as Record<string, unknown>;
            const on = payload.order_number as string | undefined;
            const parsed = on ? on.match(/^([0-9]{2})-([0-9]{3})-([0-9]{3})$/) : null;
            if (parsed) {
              const deviceNumber = parsed[1];
              const { orderNumber: newOn } = generateOrderNumber(deviceNumber, command.business_id);
              const newPayload = { ...payload, order_number: newOn };
              await db.runAsync(`UPDATE commands SET payload = ?, error = ?, updated_at = ? WHERE command_id = ?;`, JSON.stringify(newPayload), `retry_random:${message}`, new Date().toISOString(), command.command_id);
              syncLogger.info("CommandQueueService", "Regenerated order_number after 409", { command_id: command.command_id, new_order_number: newOn });
              // keep retry_count unchanged so next replay retries; do not mark failed twice
              return;
            }
          } catch {}
        }
        await updateCommandStatus(db, command.command_id, "failed", `order_number_taken:${message}`);
        throw error;
      }
      const isNonRetryable =
        apiErr?.name === "ApiError" &&
        typeof apiErr.status === "number" &&
        apiErr.status >= 400 &&
        apiErr.status < 500;
      if (isNonRetryable) {
        await updateCommandStatus(db, command.command_id, "failed", `permanent:${message}`);
        syncLogger.warn("CommandQueueService", "Queued command rejected by server (not retrying)", {
          command_id: command.command_id,
          command_type: command.command_type,
          status: apiErr.status,
          error: message,
        });
        // Do not throw — allow replay to continue to next command.
        return;
      }
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
    // Join an in-flight replay instead of no-op'ing: concurrent replays
    // (connectivity auto-replay racing an explicit replay) must converge on
    // the same outcome, otherwise callers observe a drained queue while work
    // is still flying.
    if (this.replaying) {
      syncLogger.debug("CommandQueueService", "Replay already in progress, joining");
      try { await this.replaying; } catch {}
      return;
    }

    let resolveReplay!: () => void;
    this.replaying = new Promise<void>((r) => { resolveReplay = r; });
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
        } catch (e) {
          const apiErr = e as { status?: number; name?: string };
          const isNonRetryable =
            apiErr?.name === "ApiError" &&
            typeof apiErr.status === "number" &&
            apiErr.status >= 400 &&
            apiErr.status < 500;
          if (isNonRetryable) {
            // Already marked permanent in processCommand — continue to next.
            continue;
          }
          // Network/5xx — stop to preserve ordering; retry later.
          break;
        }
      }
    } finally {
      this.replaying = null;
      try { resolveReplay(); } catch {}
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
