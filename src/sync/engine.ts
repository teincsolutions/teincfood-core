/**
 * Sync Engine orchestrator.
 *
 * Phase 1 responsibility: receive commands from repositories and route them
 * to the active transport (currently REST only).
 *
 * Future phases will add:
 *   - connectivity-aware transport selection
 *   - command outbox persistence
 *   - replay
 *   - Local Node transport
 *   - cloud reconciliation
 */

import type { Command, DomainEvent, Transport } from "./types";
import { restTransport } from "./transport-rest";
import { localNodeTransport } from "./transport-local-node";
import { commandQueueService } from "./command-queue.service";
import { getConnectivityState } from "../adapters/connectivity";
import { ApiError } from "../adapters/http";
import { errorCodeOf } from "./transition-errors";
import { syncLogger } from "../utils/sync-logger";
import { CLOUD_COMMAND_TIMEOUT_MS, LAN_COMMAND_TIMEOUT_MS } from "../utils/constants";
import { CAPABILITY_BY_COMMAND } from "../reference/capabilities";
import { getReferenceData } from "../reference/operations";
import { openSyncDatabase } from "../db/connection";
import { canBusinessSync } from "./sync-guard";
import { TRANSITION_ERROR_CODES, TransitionError } from "./transition-errors";
import { isOrderTransition } from "./transition-endpoints";
import { assertEntitledForCommand } from "../reference/entitlement-guard";
import { noteRateLimited, extractRetryAfterMs } from "./rate-limit";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface SyncEngineOptions {
  /** Ordered list of transports the engine may use. */
  transports: Transport[];
}

/**
 * Cash sales must never be refused for lack of entitlement proof: the POS
 * domain defaults a missing method to cash, and only cash can be fulfilled
 * without the backend. Anything else keeps the fail-closed guard.
 */
function isCashOrderCreate(command: Command): boolean {
  if (command.command_type !== "order:create") return false;
  const method = (command.payload as { pos_payment_method?: unknown } | null)?.pos_payment_method;
  return method === undefined || method === "cash";
}

export class SyncEngine {
  private transports: Transport[];
  private eventSubscribers: Array<(event: DomainEvent) => void> = [];

  constructor(options: SyncEngineOptions) {
    this.transports = options.transports;
  }

  /**
   * Execute a command through the appropriate transport.
   *
   * Transport selection:
   *   - Cloud reachable and REST transport available → REST
   *   - Local Node enabled and available → LocalNodeTransport
   *   - Otherwise queue locally and return an optimistic event
   *
   * Cloud commands are raced against CLOUD_COMMAND_TIMEOUT_MS so a slow
   * internet connection falls back to the Local Node (or the offline outbox)
   * quickly instead of blocking the terminal for the full HTTP timeout.
   */
  async execute(command: Command, opts?: { forReplay?: boolean }): Promise<DomainEvent[]> {
    if (!command.business_id || !canBusinessSync(command.business_id)) {
      // No active business/auth — don't route to cloud/LAN or queue with empty bid.
      throw new TransitionError(TRANSITION_ERROR_CODES.NO_ACTIVE_BUSINESS, "Sync requires active business and login — business_id missing or not authenticated");
    }
    syncLogger.command(command, "issued");

    // Create-before-transition: a transition can only apply to an order that
    // exists server-side. If its order:create is still queued, queue the
    // transition behind it; if the create dead-lettered, discard the
    // transition. POSTing a transition ahead of (or without) its create is a
    // guaranteed 404 and must never happen.
    if (isOrderTransition(command.command_type) && command.entity_id) {
      const gate = await commandQueueService.orderCreateGate(command.business_id, command.entity_id);
      if (gate === "failed") {
        syncLogger.warn("SyncEngine", "Transition discarded — parent order:create failed", {
          command_id: command.command_id,
          command_type: command.command_type,
          entity_id: command.entity_id,
        });
        throw new TransitionError(
          TRANSITION_ERROR_CODES.ORDER_NOT_FOUND,
          "Parent order creation failed — transition discarded",
        );
      }
      if (gate === "pending") {
        if (opts?.forReplay) {
          throw new TransitionError(
            TRANSITION_ERROR_CODES.REPLAY_DEFERRED,
            "Parent order:create still queued — deferring transition",
          );
        }
        const event = await commandQueueService.enqueue(command);
        this.broadcast(event);
        return [event];
      }
    }

    // Perms guard (offline-capable): block before routing
    const required = CAPABILITY_BY_COMMAND[command.command_type];
    if (required) {
      try {
        const db = await openSyncDatabase();
        const rec = await getReferenceData(db, command.business_id, "capabilities");
        const caps: string[] = (rec?.payload as unknown as { data?: { capabilities?: string[] } })?.data?.capabilities ?? [];
        // If capabilities cached and missing required, block locally
        if (rec && caps.length > 0 && !caps.includes(required)) {
          throw new ApiError(`Missing capability: ${required}`, 403, "FORBIDDEN");
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) throw e;
        // otherwise fail open
      }
    }

    // Entitlement guard (offline-first): subscription-gated commands need
    // cached proof before routing — EXCEPT cash order:create, which always
    // queues so the terminal never refuses a sale offline. The backend 402
    // remains the backstop at replay; the queued event is flagged so the
    // pending list can badge it until the server confirms.
    let queueDespiteEntitlement = false;
    try {
      await assertEntitledForCommand(command.business_id, command.command_type);
    } catch (e) {
      if (
        e instanceof TransitionError &&
        e.code === TRANSITION_ERROR_CODES.SUBSCRIPTION_REQUIRED
      ) {
        if (isCashOrderCreate(command)) {
          queueDespiteEntitlement = true;
          syncLogger.warn("SyncEngine", "queueing cash order without entitlement proof", {
            command_id: command.command_id,
            business_id: command.business_id,
          });
        } else {
          throw e;
        }
      } else {
        // Guard infra failure (no DB yet, corrupt cache) must not brick the
        // terminal — backend remains the authority. Log and continue.
        syncLogger.warn("SyncEngine", "entitlement guard skipped", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const initialStrategy = this.resolveStrategy(command);

    const { isCloudReachable, isOnline } = getConnectivityState();
    syncLogger.info("SyncEngine", "Command strategy resolved", {
      command_id: command.command_id,
      command_type: command.command_type,
      strategy: initialStrategy,
      isCloudReachable,
      isOnline,
      cloud_available: restTransport.isAvailable(),
      lan_available: localNodeTransport.isAvailable(),
    });

    // Ordered attempts for THIS execution only. Every await below is capped,
    // so the UI can never hang: a stale "reachable" belief may send the
    // first attempt to a dead cloud, but it is tried ONCE (2.5s cap) and
    // never re-entered — the command downgrades to LAN, then the outbox.
    const attempts: Array<"cloud" | "local_node" | "queue"> =
      initialStrategy === "cloud"
        ? [
            "cloud",
            ...(localNodeTransport.isAvailable() ? (["local_node"] as const) : []),
            "queue" as const,
          ]
        : initialStrategy === "local_node"
          ? ["local_node", "queue"]
          : ["queue"];

    let lastError: unknown = null;
    for (const attempt of attempts) {
      if (attempt === "queue") {
        // Replays must never re-enqueue-then-delete (the command would eat
        // itself without executing). If no real transport is available, leave
        // the row untouched for a later trigger. Distinct code so the outbox
        // stops the whole replay pass (nothing can succeed) rather than
        // skipping just this entity and hammering the rest.
        if (opts?.forReplay) {
          // A transport DID answer (e.g. HTTP 5xx) or failed at the network
          // layer: preserve that error so the outbox treats it as a per-entity
          // failure and keeps draining independent commands. Only a genuine
          // "no transport attempted" pass stops replay entirely — otherwise a
          // single broken entity (like a 500 on one menu delete) would wedge
          // every later command, including menu creates needed by orders.
          if (lastError) throw lastError;
          throw new TransitionError(TRANSITION_ERROR_CODES.REPLAY_NO_TRANSPORT, "No transport available, keeping command queued");
        }
        const event = await commandQueueService.enqueue(command);
        if (queueDespiteEntitlement) {
          event.payload = {
            ...(event.payload as Record<string, unknown>),
            entitlement_unverified: true,
          };
        }
        this.broadcast(event);
        // Menu writes need a visible local effect while queued: patch the
        // durable reference cache optimistically and fan out
        // reference_data.changed so reconciliation applies it locally and
        // relays it to LAN peers (replay re-applies idempotently; the backend
        // owns versions on cloud convergence).
        if (command.command_type.startsWith("menu:")) {
          try {
            const { applyMenuCommandLocal } = await import("../reference/menu-apply");
            const { keys } = await applyMenuCommandLocal(command.business_id, command);
            if (keys.length) {
              const { REFERENCE_CHANGED_EVENT_TYPE } = await import("../reference/events");
              const { generateEventId } = await import("../utils/uuid");
              this.broadcast({
                event_id: generateEventId(),
                event_type: REFERENCE_CHANGED_EVENT_TYPE as DomainEvent["event_type"],
                event_version: "1.0",
                entity_id: command.business_id,
                user_id: command.user_id,
                device_id: command.device_id,
                payload: { business_id: command.business_id, keys } as unknown as Record<string, unknown>,
                timestamp: new Date().toISOString(),
              });
            }
          } catch (e) {
            syncLogger.debug("SyncEngine", "queued menu optimistic apply failed", { err: String(e) });
          }
        }
        return [event];
      }

      const transport = attempt === "cloud" ? restTransport : localNodeTransport;
      const cap = attempt === "cloud" ? CLOUD_COMMAND_TIMEOUT_MS : LAN_COMMAND_TIMEOUT_MS;
      try {
        const events = await withTimeout(transport.execute(command), cap);
        for (const event of events) {
          this.broadcast(event);
        }
        syncLogger.command(command, "completed", {
          event_count: events.length,
          transport: transport.name,
        });
        if (attempt === "cloud") {
          // Cloud just worked: replay anything queued during the outage.
          // Flag-neutral: only the health probe writes isCloudReachable — a
          // single success here is not its decision to make either.
          this.replayQueuedCommands().catch((error) => {
            syncLogger.error("SyncEngine", "Replay after cloud success failed", {
              error: String(error),
            });
          });
        }
        return events;
      } catch (error) {
        // Definitive hours-guard rejection (thrown by createLocalOrder before
        // any HTTP): the business is closed. Surface it immediately — do not
        // mark cloud unreachable and do not fall back to the outbox, which
        // would either re-throw from the enqueue gate or mask a real decision
        // as a connectivity problem.
        const code = errorCodeOf(error);
        if (code === "BUSINESS_CLOSED" || code === "HOURS_NOT_SYNCED") {
          syncLogger.warn("SyncEngine", "Command blocked: business closed", {
            command_type: command.command_type,
            command_id: command.command_id,
            code,
          });
          throw error;
        }
        // Definitive server rejection (4xx): the backend answered with a real
        // decision (e.g. INVALID_TRANSITION, PAYMENT_REQUIRED, FORBIDDEN).
        // Surface it instead of masking it as a connectivity problem and
        // silently queueing a command that can never succeed. Shape-based
        // (status range), never instanceof: apps throw their own ApiError
        // class, and TransitionError guards carry no HTTP status.
        const rejectionStatus = typeof (error as { status?: unknown })?.status === "number"
          ? (error as { status: number }).status
          : undefined;
        if (rejectionStatus !== undefined && rejectionStatus >= 400 && rejectionStatus < 500) {
          // 429 is transient back-pressure, not a verdict: open the global
          // cooldown so background sync pauses, then surface as usual (the
          // outbox replay path classifies 429 separately and defers).
          if (rejectionStatus === 429) {
            noteRateLimited(extractRetryAfterMs(error));
          }
          syncLogger.warn("SyncEngine", "Command rejected by server", {
            command_type: command.command_type,
            command_id: command.command_id,
            transport: transport.name,
            status: rejectionStatus,
            code,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        // Timeout or network error: downgrade to the next attempt (LAN, then
        // outbox) so the terminal stays responsive. Flag-neutral: only the
        // health probe writes isCloudReachable — a failed request is never
        // evidence the cloud is down (it may be a logic rejection without a
        // numeric status, e.g. TransitionError). The probe detects real
        // outages; queued work replays when it reports recovery.
        syncLogger.warn("SyncEngine", `${transport.name} attempt failed, downgrading`, {
          command_type: command.command_type,
          command_id: command.command_id,
          error: String(error),
        });
        lastError = error;
      }
    }

    // Unreachable: attempts always ends with "queue", which returns.
    throw lastError ?? new Error("SyncEngine: no transport attempt succeeded");
  }

  /**
   * Trigger replay of queued commands when connectivity returns.
   */
  async replayQueuedCommands(): Promise<void> {
    await commandQueueService.replay();
  }

  subscribe(handler: (event: DomainEvent) => void): () => void {
    this.eventSubscribers.push(handler);
    return () => {
      const index = this.eventSubscribers.indexOf(handler);
      if (index > -1) {
        this.eventSubscribers.splice(index, 1);
      }
    };
  }

  /**
   * Publish a notification event to local subscribers without a transport
   * round-trip. Used for cross-device notifications (e.g. reference data
   * changed) that are not backed by a command: the event is broadcast locally
   * so the reconciliation bridge can relay it to LAN clients.
   */
  publish(event: DomainEvent): void {
    this.broadcast(event);
  }

  private resolveStrategy(_command: Command): "cloud" | "local_node" | "queue" {
    const { isCloudReachable, isOnline } = getConnectivityState();

    // Cloud-first when we believe it is reachable OR we have not yet verified
    // it (unknown). Only a confirmed "unreachable" status falls back to the
    // Local Node / outbox. Commands issued on a healthy connection must never
    // get stuck in the local outbox.
    if (
      (isCloudReachable === "reachable" || isCloudReachable === "unknown") &&
      restTransport.isAvailable()
    ) {
      return "cloud";
    }

    // Local Node fallback when enabled and connected.
    if (localNodeTransport.isAvailable()) {
      return "local_node";
    }

    // No network at all: queue immediately.
    if (!isOnline) {
      return "queue";
    }

    // Network present but cloud status unknown or unreachable. Try cloud first;
    // a failed HTTP call will bubble up and the caller (e.g. queue replay) can
    // decide to retry. New commands issued while cloud is unknown are queued to
    // avoid blocking the UI on a flaky connection.
    if (isCloudReachable === "unreachable") {
      return "queue";
    }

    return "cloud";
  }

  private broadcast(event: DomainEvent): void {
    syncLogger.event(event, "broadcast");
    this.eventSubscribers.forEach((handler) => handler(event));
  }
}

export const syncEngine = new SyncEngine({
  transports: [restTransport, localNodeTransport],
});

commandQueueService.setSyncEngine(syncEngine);
