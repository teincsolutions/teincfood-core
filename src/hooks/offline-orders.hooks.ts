/**
 * Offline order hydration — single source for both apps.
 *
 * On startup / business change, seeds the TanStack Query cache from the
 * durable SQLite order read-model so seller, POS, kitchen and display
 * screens render current + recent orders immediately, even before any
 * network fetch completes (and fully offline after a restart).
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { orderSnapshotsService } from "../sync/order-snapshots.service";
import { SELLER_KEYS, POS_KEYS } from "./orders.hooks";
import type { SellerOrder } from "../types/api/seller.api";

export function useOfflineOrderHydration() {
  const queryClient = useQueryClient();
  const businessId = useSyncExternalStore(subscribeBusiness, () => getActiveBusiness()?.id ?? null, () => null);

  useEffect(() => {
    if (!businessId) return;

    const bid = businessId;
    let cancelled = false;

    async function hydrate() {
      const orders = await orderSnapshotsService.getSellerList(bid, bid);
      if (cancelled || !orders || orders.length === 0) return;

      const pages: {
        pages: { data: SellerOrder[]; pagination: Record<string, unknown> }[];
        pageParams: number[];
      } = {
        pages: [
          {
            data: orders,
            pagination: {
              page: 1,
              total_pages: 1,
              page_size: orders.length,
              total_entries: orders.length,
            },
          },
        ],
        pageParams: [1],
      };

      // Seed the same key shape the seller and POS screens use with no filters.
      queryClient.setQueryData([...SELLER_KEYS.orders(bid)] as unknown as readonly unknown[], pages);
      queryClient.setQueryData([...POS_KEYS.orders(bid), undefined], pages);
    }

    hydrate().catch(() => {});
    orderSnapshotsService.pruneOld().catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [businessId, queryClient]);
}
