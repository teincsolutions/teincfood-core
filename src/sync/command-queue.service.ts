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
import { recordAttempt } from "../utils/attempt-stats";
import { TransitionError, isReplayDeferred, isReplayNoTransport, TRANSITION_ERROR_CODES } from "./transition-errors";
import { assertBusinessOpenForCreate } from "../utils/business-hours";
import { extractApiErrorCode } from "../utils/error";
import { generateEventId } from "../utils/uuid";
import { buildItemSnapshots, snapshotsToOrderLines } from "../domain/orders/snapshots";
import type { SnapshotCartLine } from "../domain/orders/snapshots";
import {
  generateLocalCalloutNumber,
  generateOrderNumberForBusiness,
  generateOrderNumber,
} from "./order-number";
import type { SyncEngine } from "./engine";
import { getConnectivityState, subscribeConnectivity } from "../adapters/connectivity";
import { canBusinessSync } from "./sync-guard";
import { backoffDelayMs } from "./backoff";

const MAX_RETRIES = 5;

/**
 * Stop a replay pass after this many consecutive transport-level failures
 * (network/timeout/5xx) so a dead server is not hammered once per queued
 * command. Any server response (2xx, permanent 4xx) or deferral resets the
 * counter. The next trigger (connectivity/backoff) starts a fresh pass.
 */
const TRANSPORT_FAILURE_BREAKER = 3;

/**
 * 4xx that deserve another chance: transient races and rate limits, never
 * permanent verdicts. Anything else 4xx (400 validation, 401 session,
 * 402 plan, 403 forbidden) fails fast with a toast. 409 ORDER_NUMBER_TAKEN
 * has its own regen path below and is not capped (every attempt mints a
 * new order number, so it is never a blind retry).
 */
const RETRYABLE_4XX: ReadonlySet<number> = new Set([404, 408, 409, 422, 429]);

/** In-memory next-eligible time per command (shared 2s→5min curve). */
const retryNotBefore = new Map<string, number>();

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
  const snapshots = buildItemSnapshots(
    ((payload.item_snapshots ?? payload.items ?? []) as SnapshotCartLine[]),
  );
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
    items: snapshotsToOrderLines(snapshots, command.command_id as string) as SellerOrder["items"],
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
        if (!canBusinessSync()) return;
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
    // Queue-time hours gate: a closed business can never legally sync an
    // order:create, so fail fast with BusinessHoursError instead of queuing
    // an optimistic order that would sit pending forever. Other command
    // types (transitions, payments, delivery) are unaffected so in-progress
    // orders can still be completed while closed.
    if (command.command_type === "order:create") {
      await assertBusinessOpenForCreate(command.business_id, new Date(), "pos");
    }
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
    if (!canBusinessSync(command.business_id)) {
      // No active business/session — defer until login+selection.
      throw new TransitionError(TRANSITION_ERROR_CODES.REPLAY_DEFERRED, "No business/auth, deferring queued command");
    }
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

    // Backoff pacing for retryable failures: the next replay skips (defers)
    // this command until its slot, preserving FIFO without a hot loop.
    const notBefore = retryNotBefore.get(command.command_id);
    if (notBefore !== undefined && notBefore > Date.now()) {
      throw new TransitionError(
        TRANSITION_ERROR_CODES.REPLAY_DEFERRED,
        "In retry backoff, deferring queued command",
      );
    }

    if (!this.syncEngine) {
      throw new Error("CommandQueueService: SyncEngine not initialized");
    }

    await markCommandInFlight(db, command.command_id);

    try {
      const events = await this.syncEngine.execute(parsedCommand, { forReplay: true });
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
      // Replay with no transport available: leave the row exactly as-is for
      // the next trigger (do not mark, do not count). Must reset the
      // in_flight flag first — rows stuck in_flight are invisible to the
      // outbox query and would wedge the queue forever.
      if (isReplayNoTransport(error)) {
        await updateCommandStatus(db, command.command_id, "pending", "deferred:no-transport");
        throw error;
      }
      // Per-command backoff (retry window or retryable-4xx backoff): leave the
      // row pending and rethrow so the pass defers just this entity.
      if (isReplayDeferred(error)) {
        await updateCommandStatus(db, command.command_id, "pending", "deferred:backoff");
        throw error;
      }
      const apiErr = error as { status?: number; name?: string; code?: string; data?: unknown };
      const message = error instanceof Error ? error.message : String(error);
      // 409 ORDER_NUMBER_TAKEN is retryable once with new RRR (exact backend code, any envelope)
      const code = extractApiErrorCode(error);
      if (apiErr?.status === 409 && code === "ORDER_NUMBER_TAKEN") {
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
              // keep retry_count unchanged so next replay retries; do not mark failed twice.
              // Reset in_flight → pending so the row stays visible to the outbox query.
              await updateCommandStatus(db, command.command_id, "pending", `retry_random:${message}`);
              return;
            }
          } catch {}
        }
        await updateCommandStatus(db, command.command_id, "failed", `order_number_taken:${message}`);
        throw error;
      }
      const status = typeof apiErr?.status === "number" ? apiErr.status : undefined;
      // Already-applied absorb: a 422/404 against an order the server
      // already moved (duplicate tap, earlier drain won the race) is
      // success, not failure. Verified against server truth via pull
      // (HLC-guarded: pulled rows overwrite local), never the optimistic row.
      if (
        status === 422 ||
        code === "INVALID_TRANSITION" ||
        (status === 404 && command.command_type !== "order:create")
      ) {
        try {
          if (await this.absorbIfApplied(command)) return;
        } catch {}
      }
      // Retryable 4xx (FIFO races, rate limits): back off on the shared
      // 2s→5min curve, then fail loudly after MAX_RETRIES. Throw a
      // transport-neutral deferral so replay STOPS here (FIFO ordering) —
      // rethrowing the 4xx itself would make the loop `continue` past it.
      if (status !== undefined && RETRYABLE_4XX.has(status)) {
        const attempts = command.retry_count + 1;
        if (attempts >= MAX_RETRIES) {
          await this.failPermanently(db, command, message, `retryable 4xx exhausted after ${attempts} attempts`);
          return;
        }
        retryNotBefore.set(command.command_id, Date.now() + backoffDelayMs(command.retry_count));
        await updateCommandStatus(db, command.command_id, "pending", `retry_4xx:${message}`, true);
        syncLogger.warn("CommandQueueService", "Retryable 4xx — backing off", {
          command_id: command.command_id,
          command_type: command.command_type,
          status,
          attempt: attempts,
        });
        throw new TransitionError(
          TRANSITION_ERROR_CODES.REPLAY_DEFERRED,
          `Retryable ${status} on ${command.command_type}, backing off`,
        );
      }
      const isNonRetryable =
        status !== undefined &&
        status >= 400 &&
        status < 500;
      if (isNonRetryable) {
        await this.failPermanently(db, command, message, "permanent 4xx");
        // Do not throw — allow replay to continue to next command.
        return;
      }
      // Network/timeout/5xx: NOT a rejection — keep the command retryable
      // indefinitely (status back to pending, retry_count untouched) so a
      // long outage never dead-letters the outbox via MAX_RETRIES. Replay
      // stops here to preserve ordering; the next trigger retries.
      await updateCommandStatus(db, command.command_id, "pending", `network:${message}`);
      syncLogger.command(parsedCommand, "queued", { error: message, deferred: true });
      throw error;
    }
  }

  /**
   * Mark a command permanently failed: loud toast + optimistic revert, then
   * replay continues to the next command. Shared by the exhausted-retry and
   * permanent-rejection paths.
   */
  private async failPermanently(
    db: ReturnType<typeof getSyncDatabase>,
    command: PersistedCommand,
    message: string,
    reason: string,
  ): Promise<void> {
    await updateCommandStatus(db, command.command_id, "failed", `permanent:${message}`);
    syncLogger.warn("CommandQueueService", `Queued command failed (${reason})`, {
      command_id: command.command_id,
      command_type: command.command_type,
      error: message,
    });
    try {
      const { notifyError } = await import("../adapters/notify");
      notifyError(`Server rejected ${command.command_type}: ${message}`);
    } catch {}
    try {
      if (command.command_type.startsWith("menu:") && command.entity_id) {
        const { revertMenuCommand } = await import("../reference/menu-apply");
        await revertMenuCommand(command.business_id, command.command_type, command.entity_id);
      }
    } catch {}
  }

  /**
   * Already-applied absorb: pull server truth, and if the order is already
   * at this command's target status, delete the command as success. The
   * absorb ONLY fires when the pull actually touched the row (hlc change) —
   * otherwise a stale local optimistic write could mask a genuine race and
   * delete work the server never applied.
   */
  private async absorbIfApplied(command: PersistedCommand): Promise<boolean> {
    const target = QUEUED_STATUS_BY_COMMAND[command.command_type];
    if (!target || !command.entity_id) return false;
    try {
      const db = getSyncDatabase();
      const before = await db.getFirstAsync<{ hlc: string | null }>(
        `SELECT hlc FROM orders WHERE business_id = ? AND id = ?;`,
        command.business_id,
        command.entity_id,
      );
      const { pullRemoteOrders } = await import("./sync-jobs.service");
      await pullRemoteOrders(command.business_id);
      const afterHlc = await db.getFirstAsync<{ hlc: string | null }>(
        `SELECT hlc FROM orders WHERE business_id = ? AND id = ?;`,
        command.business_id,
        command.entity_id,
      );
      if (!afterHlc || afterHlc.hlc === before?.hlc) return false;
      const { getOrderById } = await import("../db/operations");
      const order = await getOrderById(db, command.business_id, command.entity_id);
      if (order && order.status === target) {
        await deleteCommand(db, command.command_id);
        retryNotBefore.delete(command.command_id);
        syncLogger.info("CommandQueueService", "Transition already applied on server, absorbing", {
          command_id: command.command_id,
          command_type: command.command_type,
          status: target,
        });
        return true;
      }
    } catch {}
    return false;
  }

  /**
   * Replay pending commands in FIFO order with entity-aware skip-and-continue.
   *
   * Ordering is preserved per entity: a failing command defers only its own
   * entity_id, so that order's later commands stay queued behind it, while
   * independent entities keep syncing in the same pass. The pass stops only
   * when nothing can make progress: no transport at all (REPLAY_NO_TRANSPORT)
   * or TRANSPORT_FAILURE_BREAKER consecutive network/5xx failures.
   */
  async replay(): Promise<void> {
    if (!canBusinessSync()) return;
    recordAttempt("sync_drain", "replay");
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

      // Entities deferred in THIS pass (backoff window or a transport failure):
      // later commands for the same entity are skipped to preserve per-entity
      // FIFO without blocking independent commands.
      const deferredEntities = new Set<string>();
      let consecutiveTransportFailures = 0;

      for (const command of pending) {
        const entity = command.entity_id;
        if (entity && deferredEntities.has(entity)) {
          syncLogger.debug("CommandQueueService", "Skipping command for deferred entity", {
            command_id: command.command_id,
            entity_id: entity,
          });
          continue;
        }
        try {
          await this.processCommand(command);
          consecutiveTransportFailures = 0;
        } catch (e) {
          // No transport at all: nothing in this pass can succeed — stop.
          if (isReplayNoTransport(e)) {
            syncLogger.info("CommandQueueService", "Replay stopped: no transport available", {
              command_id: command.command_id,
            });
            break;
          }
          // Per-command deferral (backoff window / retryable-4xx backoff):
          // defer this entity only and keep draining the rest.
          if (isReplayDeferred(e)) {
            if (entity) deferredEntities.add(entity);
            consecutiveTransportFailures = 0;
            continue;
          }
          const status = (e as { status?: number })?.status;
          const is4xx =
            typeof status === "number" && status >= 400 && status < 500;
          if (is4xx) {
            // Permanent/retryable-exhausted 4xx: processCommand already marked
            // the row failed (or absorbed it) — continue to the next command.
            consecutiveTransportFailures = 0;
            continue;
          }
          // Network/timeout/5xx: defer this entity, continue, but trip the
          // breaker if the transport looks dead so we stop hammering.
          if (entity) deferredEntities.add(entity);
          consecutiveTransportFailures += 1;
          if (consecutiveTransportFailures >= TRANSPORT_FAILURE_BREAKER) {
            syncLogger.warn("CommandQueueService", "Replay stopped: transport failure breaker tripped", {
              consecutiveTransportFailures,
            });
            break;
          }
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

  /**
   * Debug dump of the engine outbox for Diagnostics screens (all statuses,
   * newest last). Mirrors debugDumpSyncJobs.
   */
  async debugDumpCommands(
    businessId: string,
  ): Promise<Array<{ id: string; command_type: string; status: string; retry_count: number; error: string | null; created_at: string }>> {
    try {
      const db = getSyncDatabase();
      const rows = await getPendingCommands(db, Number.MAX_SAFE_INTEGER, true);
      return rows
        .filter((c) => !businessId || c.business_id === businessId)
        .map((c) => ({
          id: c.command_id,
          command_type: c.command_type,
          status: c.status,
          retry_count: c.retry_count,
          error: c.error ?? null,
          created_at: c.created_at ?? "",
        }));
    } catch {
      return [];
    }
  }
}

export const commandQueueService = new CommandQueueService();
