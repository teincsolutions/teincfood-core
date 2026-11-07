/**
 * Offline-capable mutation runner.
 *
 * Wraps a direct REST service call (used by menu edits etc.) so that when the
 * request fails with a NETWORK error (offline / cloud unreachable), the
 * operation is retried through the Sync Engine instead — which routes it to
 * the Local Node, or persists it in the durable outbox for replay when
 * connectivity returns. Definitive server rejections (4xx) are NOT touched:
 * they are real business decisions and must surface to the caller.
 *
 * Keeps the online path and its result shape unchanged.
 */

import { syncEngine } from "./engine";
import { buildCommand } from "./command-builder";
import { assertOnlineFor } from "./online-gates";
import { syncLogger } from "../utils/sync-logger";
import { ApiError } from "../adapters/http";
import { getConnectivityState } from "../adapters/connectivity";
import { CAPABILITY_BY_COMMAND } from "../reference/capabilities";
import { openSyncDatabase } from "../db/connection";
import { getReferenceData } from "../reference/operations";
import { commandQueueService } from "./command-queue.service";
import { applyMenuCommandLocal } from "../reference/menu-apply";
import { emitReferenceChanged } from "../reference/events";
import { assertEntitledForCommand } from "../reference/entitlement-guard";
import { isOnlineCapable } from "./online-gates";
import type { DomainEvent } from "./types";
import type { ReferenceDataKey } from "../reference/types";

export interface OfflineCapableOptions<TService, TCommandPayload> {
  /** Direct REST call — used online. */
  run: () => Promise<TService>;
  /** Sync-engine command fallback (Local Node / outbox). */
  commandType: string;
  businessId: string;
  entityId?: string;
  payload: TCommandPayload;
}

export interface LocalMenuMutationOptions<TCommandPayload> {
  /** Must be a `menu:*` command. */
  commandType: string;
  businessId: string;
  entityId?: string;
  payload: TCommandPayload;
}

/**
 * Enforce the cached RBAC capabilities downloaded from the backend.
 *
 * Fail-open only when no capabilities record exists yet (first boot); once a
 * record is present, an unknown capability is a real denial and must never
 * reach the local cache or the outbox.
 */
async function assertCachedCapability(
  businessId: string,
  required: string,
): Promise<void> {
  try {
    const db = await openSyncDatabase();
    const rec = await getReferenceData(db, businessId, "capabilities");
    const caps: string[] =
      (rec?.payload as unknown as { data?: { capabilities?: string[] } })?.data
        ?.capabilities ?? [];
    if (rec && caps.length > 0 && !caps.includes(required)) {
      throw new ApiError(`Missing capability: ${required}`, 403, "FORBIDDEN");
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) throw e;
  }
}

/**
 * Publish fan-out only after the local transaction has committed.
 *
 * This is deliberately scheduled off the mutation's promise: reference sync
 * and replay are downstream of SQLite, never a prerequisite for it. If either
 * fails, the local row and outbox stay intact for the next retry.
 */
function scheduleMenuPostCommit(
  businessId: string,
  keys: ReferenceDataKey[],
): void {
  setTimeout(() => {
    if (keys.length > 0) {
      try {
        emitReferenceChanged(businessId, keys);
      } catch (error) {
        syncLogger.debug("OfflineCapable", "menu reference fan-out failed", {
          error: String(error),
        });
      }
    }
    if (isOnlineCapable()) {
      void syncEngine.replayQueuedCommands().catch((error) => {
        syncLogger.debug("OfflineCapable", "menu background replay failed", {
          error: String(error),
        });
      });
    }
  }, 0);
}

/**
 * The ONLY menu write path.
 *
 * Local SQLite is the source of truth: capability/entitlement checks read the
 * cached proof, the menu row is applied to the reference cache, and the
 * command is inserted into the durable outbox. All of that completes before
 * this promise resolves. No HTTP, connectivity probe, image upload, reference
 * pull, LAN call, or replay is allowed here.
 *
 * Consumers must treat the returned event as the committed local state and
 * close the form immediately. Sync is a separate background worker.
 */
export async function commitMenuMutationLocal<TCommandPayload>(
  options: LocalMenuMutationOptions<TCommandPayload>,
): Promise<DomainEvent> {
  if (!options.commandType.startsWith("menu:")) {
    throw new Error(
      `commitMenuMutationLocal only accepts menu:* commands, got ${options.commandType}`,
    );
  }

  // Cached permission proof — local reads only. The backend remains the final
  // authority when the queued command replays.
  const required = CAPABILITY_BY_COMMAND[options.commandType];
  if (required) await assertCachedCapability(options.businessId, required);
  await assertEntitledForCommand(options.businessId, options.commandType);

  const command = buildCommand({
    commandType: options.commandType,
    businessId: options.businessId,
    entityId: options.entityId,
    payload: options.payload,
  });

  // 1) local read model, 2) durable outbox. Both are local writes.
  let keys: ReferenceDataKey[] = [];
  try {
    const applied = await applyMenuCommandLocal(options.businessId, command);
    keys = applied.keys;
  } catch (error) {
    // The outbox row is still authoritative and will re-apply on replay.
    syncLogger.debug("OfflineCapable", "menu local apply failed", {
      error: String(error),
    });
  }
  const event = await commandQueueService.enqueue(command);

  // 3) only now may the rest of the system hear about it.
  scheduleMenuPostCommit(options.businessId, keys);
  return event;
}

export async function runOfflineCapableMutation<TService, TCommandPayload>(
  options: OfflineCapableOptions<TService, TCommandPayload>,
): Promise<TService> {
  // Menu writes have a dedicated local-first API. Keep this branch for legacy
  // callers (e.g. image upload follow-ups) but route it through the same
  // commit-only implementation.
  if (options.commandType.startsWith("menu:")) {
    const event = await commitMenuMutationLocal({
      commandType: options.commandType,
      businessId: options.businessId,
      entityId: options.entityId,
      payload: options.payload,
    });
    return event.payload as TService;
  }

  // Online-required gate first: these commands can never succeed offline —
  // throw loud immediately instead of queuing what no transport can fulfill.
  assertOnlineFor(options.commandType, options.payload as Record<string, unknown>);

  // Per-command capability guard before touching local state or the network.
  const required = CAPABILITY_BY_COMMAND[options.commandType];
  if (required) await assertCachedCapability(options.businessId, required);

  try {
    // Cloud already known unreachable (or no network): skip the direct REST
    // attempt entirely — it would only burn a timeout before falling back.
    const cs = getConnectivityState();
    if (!cs.isOnline || cs.isCloudReachable === "unreachable") {
      throw new Error("offline-capable: cloud known unreachable, engine route");
    }
    return await options.run();
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      // Definitive rejection — surface it, do not queue.
      throw error;
    }

    // Network error (no response), timeout, or transport failure: route through
    // the Sync Engine (LAN node → outbox). The engine itself decides.
    syncLogger.warn("OfflineCapable", "Direct call failed, routing via Sync Engine", {
      command_type: options.commandType,
      error: error instanceof Error ? error.message : String(error),
    });

    const command = buildCommand({
      commandType: options.commandType,
      businessId: options.businessId,
      entityId: options.entityId,
      payload: options.payload,
    });

    const events = await syncEngine.execute(command);
    return events[0]?.payload as TService;
  }
}