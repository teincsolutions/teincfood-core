/**
 * Full sync: push → pull → push.
 * Push first so local edits (already HLC-bumped) reach server before pull
 * overwrites them; then pull merges; final drain pushes any remainder.
 */

import { getConnectivityState } from "../adapters/connectivity";
import { getAuthToken } from "../adapters/auth";
import { getActiveBusiness } from "../adapters/business";
import { syncLogger } from "../utils/sync-logger";
import { referenceSyncService } from "../reference/service";
import { pullRemoteOrders, drainPending } from "./sync-jobs.service";

let inFlight: Promise<void> | null = null;

export async function performFullSync(businessId?: string): Promise<void> {
  const bid = businessId ?? getActiveBusiness()?.id;
  if (!bid) return;
  const s = getConnectivityState();
  if (!s.isOnline || s.isCloudReachable === "unreachable") return;
  if (!getAuthToken()) return;
  if (inFlight) { try { await inFlight; } catch {} return; }
  const p = (async () => {
    try {
      syncLogger.info("FullSync", "Starting push→pull→push", { businessId: bid });
      // 1. Push pending FIFO first — HLC-bumped local edits outrank stale server
      try { await drainPending(bid); } catch (e) { syncLogger.warn("FullSync", "drainPending(pre) failed", { err: String(e) }); }
      // 2. Pull remote orders (HLC-guarded) and reference (LWW merge)
      try { await pullRemoteOrders(bid); } catch (e) { syncLogger.warn("FullSync", "pullRemoteOrders failed", { err: String(e) }); }
      try { await referenceSyncService.sync({ businessId: bid }); } catch (e) { syncLogger.warn("FullSync", "reference sync failed", { err: String(e) }); }
      // 3. Final drain — anything newly queued or retried after pull
      try { await drainPending(bid); } catch (e) { syncLogger.warn("FullSync", "drainPending(post) failed", { err: String(e) }); }
      syncLogger.info("FullSync", "Complete", { businessId: bid });
    } catch (e) {
      syncLogger.warn("FullSync", "Failed", { err: String(e) });
    }
  })();
  inFlight = p;
  try { await p; } finally { inFlight = null; }
}
