/**
 * E2E harness — real SQLite (memory), real SyncEngine, real command queue, real event journal.
 * Mock cloud transport in-memory to simulate backend idempotency and Phoenix business:{id}.
 */
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { closeSyncDatabase, openSyncDatabase } from "../db/connection";
import { setActiveBusiness } from "../adapters/business";
import { setConnectivityState } from "../adapters/connectivity";
import { setKVDriver } from "../adapters/kv";
import { setHttpClient } from "../adapters/http";
import { setItemSync } from "../adapters/kv";
import { orderSnapshotsService } from "../sync/order-snapshots.service";
import { hydratePendingOrders, applyPendingOrderEvent, applyOrderStateChangeEvent } from "../sync/pending-orders.service";
import { usePendingOrdersStore } from "../adapters/pending-orders";
import { syncEngine } from "../sync/engine";
import { setAuthProvider } from "../adapters/auth";
import { seedOpenHours } from "../test-helpers/seed-hours";

/** NOTE: the engine mock transport is retired with the single create path.
 * E2E tests mock the HTTP client directly (see core.e2e.test.ts) because
 * creation flows through createLocalOrder → sync_jobs → REST. */

let subscribed = false;
export async function resetHarness(businessId = "biz-e2e") {
  const driver = createMemoryDriver();
  setSqliteDriver(driver);
  try { await closeSyncDatabase(); } catch {}
  await openSyncDatabase();
  setActiveBusiness({ id: businessId });
  setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });
  setItemSync(`teinc_device_number:${businessId}`, "07");
  // ensure restTransport isAvailable (needs http client)
  setHttpClient({
    get: async () => ({ data: [] } as unknown as never),
    post: async () => ({ data: {} } as unknown as never),
    put: async () => ({ data: {} } as unknown as never),
    patch: async () => ({ data: {} } as unknown as never),
    delete: async () => ({ data: {} } as unknown as never),
  } as never);
  // reset callout
  setItemSync("teinc_callout_seq", 0);
  setItemSync("teinc_callout_seq:biz-e2e", 0);
  setItemSync("teinc_callout_seq:biz-A", 0);
  setItemSync("teinc_callout_seq:biz-B", 0);
  try { setAuthProvider(() => "token-e2e"); } catch {}
  // Creation is fail-closed on operating hours — seed 24/7 so e2e creates pass.
  await seedOpenHours(businessId).catch(() => {});
  usePendingOrdersStore.setState({ orders: [], hydrated: false });
  if (!subscribed) {
    subscribed = true;
    syncEngine.subscribe((evt) => {
      void applyPendingOrderEvent(evt, "local");
      void applyOrderStateChangeEvent(evt, "local");
    });
  }
  await hydratePendingOrders().catch(() => {});
  return businessId;
}


