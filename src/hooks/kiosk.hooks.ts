import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { listLocalOrders } from "../domain/orders/service";
import { orderRepository } from "../repositories/order.repository";
import { mergePendingIntoList } from "../sync/pending-orders.service";

export const KIOSK_KEYS = { all: ["kiosk"] as const, orders: (bid?: string) => [...KIOSK_KEYS.all,"orders",bid] as const, riders: (bid?: string) => [...KIOSK_KEYS.all,"riders",bid] as const };
function useBusinessId(): string | undefined { const id = useSyncExternalStore(subscribeBusiness, ()=>getActiveBusiness()?.id ?? null, ()=>null); return id ?? undefined; }

export function useKioskOrdersQuery(enabled=true) {
  const bid = useBusinessId();
  return useQuery({
    queryKey: KIOSK_KEYS.orders(bid),
    queryFn: async () => {
      if (!bid) return { data: [] };
      const { data } = await listLocalOrders(bid, {}, 1, 100);
      return { data: await mergePendingIntoList(data, bid, 1) };
    },
    enabled: enabled && !!bid,
    staleTime: 5*1000,
  });
}

const KIOSK_ACTIONS: Record<string, (p: { orderId: string; businessId: string }) => Promise<unknown>> = {
  accept: (p) => orderRepository.acceptOrder(p),
  reject: (p) => orderRepository.rejectOrder(p),
  start_preparing: (p) => orderRepository.startPreparingOrder(p),
  mark_ready: (p) => orderRepository.markOrderReady(p),
};
function makeKioskMutation(action: string) {
  return function useKioskMutation() {
    const bid = useBusinessId(); const qc = useQueryClient();
    return useMutation({
      mutationFn: (orderId: string) => {
        if (!bid) throw new Error("No active business");
        const run = KIOSK_ACTIONS[action];
        if (!run) throw new Error(`Unknown kiosk action ${action}`);
        // Engine route (cloud → LAN → queue) so peers converge.
        return run({ orderId, businessId: bid });
      },
      onSuccess: () => { qc.invalidateQueries({ queryKey: KIOSK_KEYS.orders(bid) }); qc.invalidateQueries({ queryKey: ["seller"] as const }); },
    });
  };
}
export const useAcceptKioskOrderMutation = makeKioskMutation("accept");
export const useRejectKioskOrderMutation = makeKioskMutation("reject");
export const useStartPreparingKioskOrderMutation = makeKioskMutation("start_preparing");
export const useMarkKioskOrderReadyMutation = makeKioskMutation("mark_ready");
export { useAssignRiderMutation } from "./orders.hooks";
