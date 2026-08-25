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
  try {
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