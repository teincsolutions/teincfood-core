/**
 * Pending orders store — holds locally queued (offline) order:create commands
 * as optimistic SellerOrders so they remain visible on every terminal until
 * the cloud acknowledges them. Observable so React hooks can subscribe.
 */

import type { SellerOrder } from "../types/api/seller.api";

let orders: SellerOrder[] = [];
let hydrated = false;

const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export function subscribePendingOrders(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let cachedSnapshot: { orders: SellerOrder[]; hydrated: boolean } = { orders, hydrated };

export function getPendingOrdersSnapshot(): { orders: SellerOrder[]; hydrated: boolean } {
  if (cachedSnapshot.orders !== orders || cachedSnapshot.hydrated !== hydrated) {
    cachedSnapshot = { orders, hydrated };
  }
  return cachedSnapshot;
}

export const usePendingOrdersStore = {
  getState: () => ({
    hydrated,
    orders: [...orders],
    addOrder: (order: SellerOrder) => {
      if (!orders.find((o) => o.order_number === order.order_number)) {
        orders = [...orders, order];
        notify();
      }
    },
    removeByOrderNumber: (orderNumber: string) => {
      const next = orders.filter((o) => o.order_number !== orderNumber);
      if (next.length !== orders.length) {
        orders = next;
        notify();
      }
    },
    removeByOrderId: (orderId: string) => {
      const next = orders.filter((o) => o.id !== orderId);
      if (next.length !== orders.length) {
        orders = next;
        notify();
      }
    },
    setHydrated: (v: boolean) => {
      if (hydrated !== v) {
        hydrated = v;
        notify();
      }
    },
  }),
  setState: (patch: Partial<{ orders: SellerOrder[]; hydrated: boolean }>) => {
    let changed = false;
    if (patch.orders !== undefined) {
      orders = [...patch.orders];
      changed = true;
    }
    if (patch.hydrated !== undefined && hydrated !== patch.hydrated) {
      hydrated = patch.hydrated;
      changed = true;
    }
    if (changed) notify();
  },
  subscribe: subscribePendingOrders,
};
