/**
 * Kiosk hooks — SQLite-first, same semantics as seller hooks but scoped to kiosk.
 * Single source for Kiosk order queries and explicit transitions.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orderRepository } from "../repositories/order.repository";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { getConnectivityState, subscribeConnectivity } from "../adapters/connectivity";
import { getPendingOrdersSnapshot, subscribePendingOrders } from "../adapters/pending-orders";
import { orderSnapshotsService } from "../sync/order-snapshots.service";
import { hydratePendingOrders } from "../sync/pending-orders.service";
import { filterOrdersOffline, paginateOffline } from "../utils/order-filter";
import type { SellerOrder } from "../types/api/seller.api";

export const KIOSK_KEYS = {
  all: ["kiosk"] as const,
  orders: (businessId?: string) => [...KIOSK_KEYS.all, "orders", businessId] as const,
  riders: (businessId?: string) => [...KIOSK_KEYS.all, "riders", businessId] as const,
} as const;

function useBusinessId(): string | undefined {
  const id = useSyncExternalStore(subscribeBusiness, () => getActiveBusiness()?.id ?? null, () => null);
  return id ?? undefined;
}

function useConnectivity() {
  const state = useSyncExternalStore(subscribeConnectivity, getConnectivityState, getConnectivityState);
  return state;
}

function isOfflineState(s: ReturnType<typeof getConnectivityState>): boolean {
  return !s.isOnline || s.isCloudReachable === "unreachable";
}

function useCorePendingOrders(businessId?: string): SellerOrder[] {
  const snap = useSyncExternalStore(subscribePendingOrders, getPendingOrdersSnapshot, getPendingOrdersSnapshot);
  useEffect(() => {
    if (snap.hydrated) return;
    void hydratePendingOrders();
  }, [snap.hydrated]);
  return useMemo(
    () => (businessId ? snap.orders.filter((o) => o.business_id === businessId) : snap.orders),
    [snap.orders, businessId],
  );
}

function mergeKioskPending(pending: SellerOrder[], server: SellerOrder[]): SellerOrder[] {
  if (pending.length === 0) return server;
  const seen = new Set<string>();
  const out: SellerOrder[] = [];
  for (const o of pending) { seen.add(o.order_number); out.push(o); }
  for (const o of server) if (!seen.has(o.order_number)) out.push(o);
  return out.sort((a, b) => (b.inserted_at ?? "").localeCompare(a.inserted_at ?? ""));
}

export function useKioskOrdersQuery(enabled = true) {
  const businessId = useBusinessId();
  const pendingOrders = useCorePendingOrders(businessId);
  const connectivity = useConnectivity();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || !businessId) return;
    if (isOfflineState(getConnectivityState())) return;
    // Background sync: refresh snapshot when online; UI reads snapshot below
    // kioskService.fetchKioskOrders is host-provided via services adapter if needed; fallback to snapshot only
    // For core, we just keep snapshot fresh via reconciliation; no direct fetch here
    void connectivity;
    void queryClient;
  }, [businessId, enabled, connectivity.isOnline, connectivity.isCloudReachable, queryClient]);

  return useQuery({
    queryKey: KIOSK_KEYS.orders(businessId),
    queryFn: async (): Promise<{ data: SellerOrder[] }> => {
      const list = businessId ? await orderSnapshotsService.getSellerList(businessId, businessId) : null;
      const base: SellerOrder[] = list ?? [];
      const merged = mergeKioskPending(pendingOrders, base);
      return { data: merged };
    },
    enabled,
    staleTime: 30 * 1000,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

function makeKioskMutation(build: (p: { orderId: string; businessId: string }) => Promise<unknown>, successMessage?: string) {
  return function useKioskMutation() {
    const businessId = useBusinessId();
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: (orderId: string) => {
        if (!businessId) throw new Error("No active business");
        return build({ orderId, businessId });
      },
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: KIOSK_KEYS.orders(businessId) });
        queryClient.invalidateQueries({ queryKey: ["seller"] as const });
        void successMessage;
      },
    });
  };
}

export const useAcceptKioskOrderMutation = makeKioskMutation(({ orderId, businessId }) => orderRepository.acceptOrder({ orderId, businessId }));
export const useRejectKioskOrderMutation = makeKioskMutation(({ orderId, businessId }) => orderRepository.rejectOrder({ orderId, businessId }));
export const useStartPreparingKioskOrderMutation = makeKioskMutation(({ orderId, businessId }) => orderRepository.startPreparingOrder({ orderId, businessId }));
export const useMarkKioskOrderReadyMutation = makeKioskMutation(({ orderId, businessId }) => orderRepository.markOrderReady({ orderId, businessId }));
// Assign rider is same as seller's useAssignRiderMutation — re-export from orders.hooks for kiosk parity
export { useAssignRiderMutation } from "./orders.hooks";
