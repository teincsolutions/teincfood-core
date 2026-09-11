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
import { syncLogger } from "../utils/sync-logger";
import { ApiError } from "../adapters/http";
import { getConnectivityState } from "../adapters/connectivity";
import { CAPABILITY_BY_COMMAND } from "../reference/capabilities";
import { openSyncDatabase } from "../db/connection";
import { getReferenceData } from "../reference/operations";

export interface OfflineCapableOptions<TService, TCommandPayload> {
  /** Direct REST call — used online. */
  run: () => Promise<TService>;
  /** Sync-engine command fallback (Local Node / outbox). */
  commandType: string;
  businessId: string;
  entityId?: string;
  payload: TCommandPayload;
}

export async function runOfflineCapableMutation<TService, TCommandPayload>(
  options: OfflineCapableOptions<TService, TCommandPayload>,
): Promise<TService> {
  // Per-command capability guard before even attempting direct call
  const required = CAPABILITY_BY_COMMAND[options.commandType];
  if (required) {
    try {
      const db = await openSyncDatabase();
      const rec = await getReferenceData(db, options.businessId, "capabilities");
      const caps: string[] = (rec?.payload as unknown as { data?: { capabilities?: string[] } })?.data?.capabilities ?? [];
      if (rec && caps.length > 0 && !caps.includes(required)) {
        throw new ApiError(`Missing capability: ${required}`, 403, "FORBIDDEN");
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) throw e;
    }
  }
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