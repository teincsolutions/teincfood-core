/**
 * Full sync: reference → push → pull → push.
 *
 * Reference (menu/hours/tax/capabilities) is pulled FIRST and non-blockingly:
 * every phase is independently swallowed, so a reference failure never
 * prevents queued orders from flushing. Getting reference in before the order
 * push means newly-launched terminals can satisfy order-creation prerequisites
 * (hour/tax/capability guards) in the same cycle.
 *
 * Orders still push before the order pull, so local edits (already HLC-bumped)
 * reach the server before the pull merge could overwrite them. The final
 * drain flushes anything newly queued or retried after the pull.
 */

import { getConnectivityState } from "../adapters/connectivity";
import { getActiveBusiness } from "../adapters/business";
import { syncLogger } from "../utils/sync-logger";
import { referenceSyncService } from "../reference/service";
import { pullRemoteOrders, drainPending } from "./sync-jobs.service";
import { canBusinessSync } from "./sync-guard";

let inFlight: Promise<void> | null = null;

export async function performFullSync(businessId?: string): Promise<void> {
  const bid = businessId ?? getActiveBusiness()?.id;
  if (!bid || !canBusinessSync(bid)) return;
  const s = getConnectivityState();
  if (!s.isOnline || s.isCloudReachable === "unreachable") return;
  if (inFlight) { try { await inFlight; } catch {} return; }
  const p = (async () => {
    try {
      syncLogger.info("FullSync", "Starting reference→push→pull→push", { businessId: bid });
      // 1. Reference first (non-blocking): menu/hours/tax/caps so order
      //    creation prerequisites are present before we flush orders.
      try { await referenceSyncService.sync({ businessId: bid }); } catch (e) { syncLogger.warn("FullSync", "reference sync failed", { err: String(e) }); }
      // 2. Push pending FIFO — HLC-bumped local edits outrank stale server
      try { await drainPending(bid); } catch (e) { syncLogger.warn("FullSync", "drainPending(pre) failed", { err: String(e) }); }
      // 3. Pull remote orders (HLC-guarded)
      try { await pullRemoteOrders(bid); } catch (e) { syncLogger.warn("FullSync", "pullRemoteOrders failed", { err: String(e) }); }
      // 4. Final drain — anything newly queued or retried after pull
      try { await drainPending(bid); } catch (e) { syncLogger.warn("FullSync", "drainPending(post) failed", { err: String(e) }); }
      syncLogger.info("FullSync", "Complete", { businessId: bid });
    } catch (e) {
      syncLogger.warn("FullSync", "Failed", { err: String(e) });
    }
  })();
  inFlight = p;
  try { await p; } finally { inFlight = null; }
}
