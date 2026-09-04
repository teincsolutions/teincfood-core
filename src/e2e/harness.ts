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
import { SyncEngine } from "../sync/engine";
import { restTransport } from "../sync/transport-rest";
import { setItemSync, getItemSync } from "../adapters/kv";
import { commandQueueService } from "../sync/command-queue.service";
import { orderSnapshotsService } from "../sync/order-snapshots.service";
import { hydratePendingOrders, applyPendingOrderEvent, applyOrderStateChangeEvent } from "../sync/pending-orders.service";
import { usePendingOrdersStore } from "../adapters/pending-orders";
import { syncEngine } from "../sync/engine";

/** In-memory backend mock: stores orders by UUID PK, emits events. */
export function createMockBackend() {
  const orders = new Map<string, unknown>();
  const events: unknown[] = [];
  return {
    orders,
    events,
    async handleCommand(cmd: { command_type: string; command_id: string; business_id: string; entity_id?: string; payload: Record<string, unknown> }) {
      if (cmd.command_type === "order:create") {
        const id = cmd.command_id;
        // 409 if same DD-RRR-CCC dup random collision — simulate 5% if caller wants
        if (orders.has(id)) return { order: orders.get(id), already: true };
        const on = cmd.payload.order_number as string;
        for (const v of orders.values()) {
          if ((v as { order_number: string }).order_number === on) {
            const err = Object.assign(new Error("ORDER_NUMBER_TAKEN"), { status: 409, code: "ORDER_NUMBER_TAKEN", name: "ApiError" });
            throw err;
          }
        }
        const order = { id, order_number: on, status: "pending", business_id: cmd.business_id, ...cmd.payload };
        orders.set(id, order);
        events.push({ type: "order.created", id, business_id: cmd.business_id });
        return { data: order, order_number: on, status: "pending" };
      }
      // other transitions — just mutate status
      const id = cmd.entity_id ?? cmd.command_id;
      const existing = orders.get(id) as { status: string } | undefined;
      if (existing) {
        const map: Record<string, string> = { "order:accept": "accepted", "order:start_preparing": "preparing", "order:mark_ready": "ready", "order:complete_pickup": "delivered", "order:cancel": "cancelled" };
        const ns = map[cmd.command_type];
        if (ns) (existing as { status: string }).status = ns;
      }
      return { ok: true };
    },
  };
}

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

export function installMockTransport(backend: ReturnType<typeof createMockBackend>) {
  const originalExecute = restTransport.execute.bind(restTransport);
  restTransport.execute = async (cmd: Parameters<typeof restTransport.execute>[0]) => {
    try {
      await backend.handleCommand(cmd as unknown as { command_type: string; command_id: string; business_id: string; entity_id?: string; payload: Record<string, unknown> });
      return [] as unknown as ReturnType<typeof restTransport.execute> extends Promise<infer T> ? T : never;
    } catch (e) {
      throw e;
    }
  };
  return () => { restTransport.execute = originalExecute; };
}
