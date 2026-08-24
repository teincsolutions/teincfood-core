/**
 * Pending orders store stub.
 */

import type { SellerOrder } from "../types/api/seller.api";

let orders: SellerOrder[] = [];
let hydrated = false;

export const usePendingOrdersStore = {
  getState: () => ({
    hydrated,
    orders,
    addOrder: (order: SellerOrder) => {
      if (!orders.find((o) => o.order_number === order.order_number)) {
        orders.push(order);
      }
    },
    removeByOrderNumber: (orderNumber: string) => {
      orders = orders.filter((o) => o.order_number !== orderNumber);
    },
    setHydrated: (v: boolean) => {
      hydrated = v;
    },
  }),
  setState: (patch: Partial<{ orders: SellerOrder[]; hydrated: boolean }>) => {
    if (patch.orders !== undefined) orders = patch.orders;
    if (patch.hydrated !== undefined) hydrated = patch.hydrated;
  },
};
