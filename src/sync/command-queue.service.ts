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
  markOrderSyncFailed,
} from "../db/operations";
import { syncLogger } from "../utils/sync-logger";
import { recordAttempt } from "../utils/attempt-stats";
import { TransitionError, isReplayDeferred, isReplayNoTransport, TRANSITION_ERROR_CODES } from "./transition-errors";
import { isOrderCreate, isOrderTransition } from "./transition-endpoints";
import { assertBusinessOpenForCreate } from "../utils/business-hours";
import { extractApiErrorCode } from "../utils/error";
import { generateEventId } from "../utils/uuid";
import { buildItemSnapshots, snapshotsToOrderLines } from "../domain/orders/snapshots";
import type { SnapshotCartLine } from "../domain/orders/snapshots";
import {
  DEFAULT_ORDER_FLOW_MODE,
  getBusinessOrderFlowMode,
  initialPosOrderStatus,
  type OrderFlowMode,
} from "../domain/orders/order-flow";
import {
  generateLocalCalloutNumber,
  generateOrderNumberForBusiness,
  generateOrderNumber,
  parseOrderNumber,
} from "./order-number";
import type { SyncEngine } from "./engine";
import { getConnectivityState, subscribeConnectivity } from "../adapters/connectivity";
import { useAuthStore } from "../adapters/auth";
import { canBusinessSync } from "./sync-guard";
import { backoffDelayMs } from "./backoff";
import { reportSyncFailure } from "../adapters/sync-failure";
import {
  paceSync,
  isRateLimited,
  getRateLimitWaitMs,
  extractRetryAfterMs,
  noteRateLimited,
  shouldReportRateLimit,
} from "./rate-limit";

const MAX_ATTEMPTS = 8;

/**
 * Stop a replay pass after this many consecutive transport-level failures
 * (network/timeout/5xx) so a dead server is not hammered once per queued
 * command. Any server response (2xx, permanent 4xx) or deferral resets the
 * counter. The next trigger (connectivity/backoff) starts a fresh pass.
 */
const TRANSPORT_FAILURE_BREAKER = 3;

/**
 * In-memory next-eligible time per command (shared 2s→5min curve).
 */
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

function buildOptimisticEvent(
  command: Command,
  flowMode: OrderFlowMode = DEFAULT_ORDER_FLOW_MODE,
): DomainEvent {
  const payload = command.payload as Record<string, unknown>;
  if (command.command_type === "order:create") {
    return {
      event_id: generateEventId(),
      event_type: `${command.command_type.replace(":", ".")}_queued`,
      event_version: "1.0",
      entity_id: command.entity_id ?? command.command_id,
      user_id: command.user_id,
      device_id: command.device_id,
      payload: buildOptimisticOrder(command, payload, flowMode),
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
        business_id: command.business_id,
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
      // Required by the offline read-model patch so queued transitions update
      // the canonical orders table (not just seller_orders snapshots).
      business_id: command.business_id,
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
  flowMode: OrderFlowMode,
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
  const method = (payload.pos_payment_method as string) ?? "cash";
  const orderType = (payload.order_type as string) ?? "takeout";
  const isCash = method === "cash";
  const authUser = useAuthStore.getState().user;
  const teller = authUser
    ? {
        id: authUser.id,
        full_name: authUser.full_name ?? authUser.email ?? "Staff",
        email: authUser.email ?? "",
        phone: authUser.phone ?? "",
        avatar_url: authUser.avatar_url ?? null,
      }
    : null;

  const orderNumber =
    (payload.order_number as string) ?? generateOrderNumberForBusiness(command.business_id);
  // Keep the optimistic callout in lock-step with the order number that was
  // already generated by createLocalOrder. Calling the sequence peek here
  // would point one order ahead.
  const parsedCallout = parseOrderNumber(orderNumber)?.callout;

  return {
    id: (command.entity_id as string) ?? command.command_id,
    order_number: orderNumber,
    callout_number: parsedCallout ? Number(parsedCallout) : generateLocalCalloutNumber(command.business_id),
    order_type: orderType,
    is_pos: payload.is_pos !== undefined ? !!payload.is_pos : true,
    customer_name: (payload.customer_name as string) ?? null,
    customer_phone: (payload.customer_phone as string) ?? null,
    pos_payment_method: method,
    paid_at: isCash ? now : null,
    // Must match createLocalOrder: direct-flow cash sales are born delivered,
    // even when the command is parked in the offline outbox. Hardcoding
    // "accepted" made a completed sale show up on the preparing board.
    status: initialPosOrderStatus(method, flowMode, orderType),
    delivery_id: null,
    delivery_status: null,
    is_paid: isCash,
    payment: {
      is_paid: isCash,
      reference: null,
      amount_minor: totalMinor,
      currency: currencyCode,
      paid_at: isCash ? now : null,
    },
    payment_mode: isCash ? "pos_cash" : "prepaid",
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
    user: teller,
    teller,
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

  // Business-scoped DD-NNNN-MMM; requires a leased device_number
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
   * Create-before-transition gate.
   *
   * A transition can only be applied to an order that exists server-side. If
   * the `order:create` for the same entity_id is still queued, the transition
   * must wait behind it (never POST first — that is a guaranteed 404). If the
   * create dead-lettered, the transition can never succeed and must be failed
   * too. A missing create row means it already synced (rows are deleted on
   * success), so the transition may proceed.
   */
  async orderCreateGate(
    businessId: string,
    entityId: string,
  ): Promise<"none" | "pending" | "failed"> {
    try {
      const db = getSyncDatabase();
      const rows = await getPendingCommands(db, Number.MAX_SAFE_INTEGER, true);
      let pending = false;
      let failed = false;
      for (const c of rows) {
        if (
          c.business_id === businessId &&
          c.entity_id === entityId &&
          c.command_type === "order:create"
        ) {
          if (c.status === "pending" || c.status === "in_flight") pending = true;
          else if (c.status === "failed") failed = true;
        }
      }
      if (pending) return "pending";
      if (failed) return "failed";
      return "none";
    } catch {
      // Fail open: never brick a terminal because the DB read failed.
      return "none";
    }
  }

  private async flagOrderSyncFailed(command: PersistedCommand, message: string): Promise<void> {
    if (!command.entity_id) return;
    try {
      await markOrderSyncFailed(getSyncDatabase(), command.business_id, command.entity_id, message);
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
    // Direct-flow cash sales are complete on creation. The optimistic order
    // must use the same cached business setting as createLocalOrder, otherwise
    // an offline direct sale appears as "accepted" and offers kitchen steps.
    const flowMode =
      preparedCommand.command_type === "order:create"
        ? await getBusinessOrderFlowMode(preparedCommand.business_id)
        : DEFAULT_ORDER_FLOW_MODE;
    const event = buildOptimisticEvent(preparedCommand, flowMode);
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

    // Create-before-transition: never replay a transition whose parent
    // order:create is still queued (it would 404), and fail it outright if
    // the create already dead-lettered (it can never succeed).
    if (isOrderTransition(command.command_type) && command.entity_id) {
      const gate = await this.orderCreateGate(command.business_id, command.entity_id);
      if (gate === "failed") {
        await this.flagOrderSyncFailed(command, "Parent order creation failed");
        await this.failPermanently(db, command, "Parent order creation failed", "parent-create-failed", {
          code: "PARENT_CREATE_FAILED",
          attempts: command.retry_count,
        });
        return;
      }
      if (gate === "pending") {
        throw new TransitionError(
          TRANSITION_ERROR_CODES.REPLAY_DEFERRED,
          "Parent order:create still queued — deferring transition",
        );
      }
    }

    if (command.retry_count >= MAX_ATTEMPTS) {
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

    // Global 429 cooldown: defer without consuming an attempt.
    if (isRateLimited()) {
      retryNotBefore.set(command.command_id, Date.now() + getRateLimitWaitMs());
      throw new TransitionError(
        TRANSITION_ERROR_CODES.REPLAY_DEFERRED,
        "Rate limited, deferring queued command",
      );
    }
    // Pace background replay so a deep queue drains at ~3 req/sec, not a burst.
    await paceSync();

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
      const code = extractApiErrorCode(error);
      // 429: open the global cooldown, defer this entity, and DO NOT consume a
      // retry attempt — the command is fine, the server is only busy.
      if (apiErr?.status === 429) {
        const retryAfterMs = extractRetryAfterMs(error);
        noteRateLimited(retryAfterMs);
        if (shouldReportRateLimit()) {
          this.reportFailure(command, {
            status: 429,
            code: code ?? "RATE_LIMIT_EXCEEDED",
            message,
            attempts: command.retry_count,
            terminal: false,
          });
        }
        retryNotBefore.set(command.command_id, Date.now() + (retryAfterMs ?? getRateLimitWaitMs()));
        await updateCommandStatus(db, command.command_id, "pending", `retry_429:${message}`);
        syncLogger.warn("CommandQueueService", "Rate limited (429) — backing off", {
          command_id: command.command_id,
          command_type: command.command_type,
          retry_after_ms: retryAfterMs,
        });
        throw new TransitionError(
          TRANSITION_ERROR_CODES.REPLAY_DEFERRED,
          `Rate limited on ${command.command_type}, backing off`,
        );
      }
      // 409 ORDER_NUMBER_TAKEN is retryable once with new RRR (exact backend code, any envelope)
      if (apiErr?.status === 409 && code === "ORDER_NUMBER_TAKEN") {
        if (command.command_type === "order:create") {
          try {
            const payload = command.payload as Record<string, unknown>;
            const on = payload.order_number as string | undefined;
            const parsed = on ? on.match(/^([0-9]{2})-([0-9]{3,4})-([0-9]{3})$/) : null;
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
        this.reportFailure(command, {
          status: 409,
          code: "ORDER_NUMBER_TAKEN",
          message,
          attempts: command.retry_count + 1,
          terminal: true,
        });
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
      // A delete of a row the server never had is already the desired end
      // state (common for locally-created items removed before their create
      // ever synced). Treat it as success so the tombstone survives without
      // retrying a permanent 404 or tripping the transport breaker.
      if (
        status === 404 &&
        (command.command_type === "menu:delete_item" ||
          command.command_type === "menu:delete_category")
      ) {
        await deleteCommand(db, command.command_id);
        retryNotBefore.delete(command.command_id);
        syncLogger.info("CommandQueueService", "Delete already applied on server, absorbing", {
          command_id: command.command_id,
          command_type: command.command_type,
          entity_id: command.entity_id,
        });
        return;
      }
      // Transition 404: the server has no such order. The absorb above already
      // checked the duplicate-tap / replayed-race case; if it did not apply,
      // replaying can never create the order — fail fast instead of burning
      // the bounded 4xx retry budget on a resource that is gone.
      if (status === 404 && isOrderTransition(command.command_type)) {
        await this.flagOrderSyncFailed(command, `Order not found on server (${message})`);
        await this.failPermanently(db, command, message, "404-order-missing", {
          status,
          code,
          attempts: command.retry_count + 1,
        });
        return;
      }
      // Every other failure is retryable on the shared 2s→5min backoff.
      //
      // 4xx (validation/permission/plan races) is bounded: a device stuck in
      // a bad local state keeps retrying, then dead-letters so an operator is
      // alerted and can visit the device. 5xx/network is an outage, not a
      // device problem — it keeps retrying indefinitely so a long outage can
      // never lose good orders. Every attempt is reported to observability.
      const is4xxResponse = status !== undefined && status >= 400 && status < 500;
      if (is4xxResponse) {
        const attempts = command.retry_count + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await this.failPermanently(db, command, message, `4xx exhausted after ${attempts} attempts`, {
            status,
            code,
            attempts,
          });
          return;
        }
        this.reportFailure(command, { status, code, message, attempts, terminal: false });
        retryNotBefore.set(command.command_id, Date.now() + backoffDelayMs(command.retry_count));
        await updateCommandStatus(db, command.command_id, "pending", `retry_4xx:${message}`, true);
        syncLogger.warn("CommandQueueService", "4xx — backing off", {
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
      // 5xx / network / timeout: keep the command retryable indefinitely
      // (status back to pending, retry_count untouched) so a long outage never
      // dead-letters the outbox. Replay defers this entity; the next trigger
      // retries.
      this.reportFailure(command, { status, code, message, attempts: command.retry_count, terminal: false });
      await updateCommandStatus(db, command.command_id, "pending", `network:${message}`);
      syncLogger.command(parsedCommand, "queued", { error: message, deferred: true });
      throw error;
    }
  }

  /** Forward a failed attempt to the host's observability reporter. */
  private reportFailure(
    command: PersistedCommand,
    extra: { status?: number; code?: string; message?: string; attempts?: number; terminal: boolean },
  ): void {
    reportSyncFailure({
      phase: "outbox",
      business_id: command.business_id,
      user_id: command.user_id,
      device_id: command.device_id,
      command_type: command.command_type,
      command_id: command.command_id,
      entity_id: command.entity_id,
      ...extra,
    });
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
    extra?: { status?: number; code?: string; attempts?: number },
  ): Promise<void> {
    await updateCommandStatus(db, command.command_id, "failed", `permanent:${message}`);
    this.reportFailure(command, { ...extra, message, terminal: true });
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
    try {
      if (isOrderTransition(command.command_type) || isOrderCreate(command.command_type)) {
        await this.flagOrderSyncFailed(command, message);
      }
    } catch {}
    // A failed order:create strands every transition queued behind it — fail
    // them too (they can never apply) instead of replaying them into a 404.
    if (isOrderCreate(command.command_type) && command.entity_id) {
      await this.failDependentTransitions(db, command, message);
    }
  }

  /**
   * Dead-letter every pending transition for an entity whose parent
   * order:create permanently failed.
   */
  private async failDependentTransitions(
    db: ReturnType<typeof getSyncDatabase>,
    createCommand: PersistedCommand,
    message: string,
  ): Promise<void> {
    try {
      const pending = await getPendingCommands(db, Number.MAX_SAFE_INTEGER);
      const rows = pending.filter(
        (c) =>
          c.business_id === createCommand.business_id &&
          c.entity_id === createCommand.entity_id &&
          c.command_type !== "order:create",
      );
      if (!rows.length) return;
      for (const row of rows) {
        await updateCommandStatus(db, row.command_id, "failed", `parent_create_failed:${message}`);
        reportSyncFailure({
          phase: "outbox",
          business_id: createCommand.business_id,
          user_id: createCommand.user_id,
          device_id: createCommand.device_id,
          command_type: row.command_type,
          command_id: row.command_id,
          entity_id: createCommand.entity_id,
          code: "PARENT_CREATE_FAILED",
          message,
          attempts: 0,
          terminal: true,
        });
      }
      syncLogger.warn("CommandQueueService", "Dead-lettered transitions behind failed create", {
        entity_id: createCommand.entity_id,
        count: rows.length,
      });
    } catch {}
  }

  /**
   * Already-applied absorb: the server already moved the order to this
   * command's target status, so the queued command is redundant and can be
   * dropped.
   *
   * The comparison uses the SERVER status reported by the pull — the local
   * row may show this device's own queued intent and would absorb itself.
   */
  private async absorbIfApplied(command: PersistedCommand): Promise<boolean> {
    const target = QUEUED_STATUS_BY_COMMAND[command.command_type];
    if (!target || !command.entity_id) return false;
    try {
      const { pullRemoteOrders } = await import("./sync-jobs.service");
      const serverStatuses = await pullRemoteOrders(command.business_id);
      const serverStatus = serverStatuses.get(command.entity_id);
      if (serverStatus === target) {
        const db = getSyncDatabase();
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
