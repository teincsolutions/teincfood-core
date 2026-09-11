/**
 * Order hooks — SQLite is real DB (no pending overlay, no fetchAll).
 * Apps just import from "@teincfood/core".
 */
import { useEffect } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { useSyncExternalStore } from "react";
import { listLocalOrders, getLocalOrder } from "../domain/orders/service";
import { getDeviceNumber, ensureLease } from "../sync/device-lease.service";
import { getConnectivityState } from "../adapters/connectivity";
import { SELLER_DASHBOARD_KEYS } from "../adapters/query-keys";
import { openSyncDatabase } from "../db/connection";
import { getReferenceData } from "../reference/operations";
import { calculatePricing } from "../pricing/engine";
import { generateUUID } from "../utils/uuid";
import { subscribePendingOrders, getPendingOrdersSnapshot } from "../adapters/pending-orders";
import { hydratePendingOrders, mergePendingIntoList } from "../sync/pending-orders.service";
import type { POSOrderCreateRequest, POSOrderPreviewResponse, POSCartItem, POSOrderType, POSOrderItemRequest } from "../types/pos.types";
import type { SellerOrder } from "../types/api/seller.api";
import { posRepository } from "../repositories/pos.repository";
import { orderRepository } from "../repositories/order.repository";

export const POS_KEYS = { all: ["pos"] as const, orders: (bid?: string) => ["pos","orders",bid] as const, preview: (bid?: string) => ["pos","preview",bid] as const };
export const SELLER_KEYS = { all: ["seller"] as const, orders: (bid?: string, f?: Record<string, unknown>) => [...SELLER_KEYS.all,"orders",bid,f].filter((x)=>x!==undefined) as readonly unknown[], deliveries: (bid?: string, f?: Record<string, unknown>) => [...SELLER_KEYS.all,"deliveries",bid,f].filter((x)=>x!==undefined) as readonly unknown[], order: (id: string, bid?: string) => [...SELLER_KEYS.all,"order",id,bid] as const };

function useBusinessId(): string | undefined {
  const id = useSyncExternalStore(subscribeBusiness, () => getActiveBusiness()?.id ?? null, () => null);
  return id ?? undefined;
}

export function usePOSOrdersQuery(filters?: Record<string,string>, enabled=true) {
  const bid = useBusinessId();
  return useInfiniteQuery({
    queryKey: [...POS_KEYS.orders(bid), filters],
    queryFn: async ({ pageParam=1 }) => {
      if (!bid) return { data: [], pagination: { page:1, page_size:20, total_pages:1, total_count:0 } };
      const { data, total } = await listLocalOrders(bid, filters as unknown as { status?: string; q?: string }, pageParam as number, 20);
      // Offline overlay: pending creations + queued statuses (page 1). Refetch
      // is driven by the pending-orders invalidator on every apply path.
      const merged = await mergePendingIntoList(data, bid, pageParam as number);
      const totalPages = Math.max(1, Math.ceil(total/20));
      return { data: merged, pagination: { page: pageParam as number, page_size:20, total_pages: totalPages, total_count: total + (merged.length - data.length) } };
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const p = (lastPage as { pagination: { page:number; total_pages:number }}).pagination;
      return p.page < p.total_pages ? p.page+1 : undefined;
    },
    enabled: enabled && !!bid,
    staleTime: 5*1000,
    networkMode: "offlineFirst" as const,
    select: (data) => (data as { pages: { data: SellerOrder[]}[] }).pages.flatMap((p)=>p.data),
  });
}

export function useSellerOrdersQuery(enabled=true, filters?: { status?: string; q?: string; search?: string }) {
  const bid = useBusinessId();
  return useInfiniteQuery({
    queryKey: SELLER_KEYS.orders(bid, filters as Record<string,unknown>),
    queryFn: async ({ pageParam=1 }) => {
      if (!bid) return { data: [], pagination: { page:1, page_size:20, total_pages:1, total_count:0 } };
      const q = filters?.q ?? filters?.search;
      const { data, total } = await listLocalOrders(bid, { status: filters?.status, q }, pageParam as number, 20);
      const merged = await mergePendingIntoList(data, bid, pageParam as number);
      const totalPages = Math.max(1, Math.ceil(total/20));
      return { data: merged, pagination: { page: pageParam as number, page_size:20, total_pages: totalPages, total_count: total + (merged.length - data.length) } };
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const p = (lastPage as { pagination: { page:number; total_pages:number }}).pagination;
      return p.page < p.total_pages ? p.page+1 : undefined;
    },
    enabled: enabled && !!bid,
    staleTime: 5*1000,
    networkMode: "offlineFirst" as const,
    select: (data) => (data as { pages: { data: SellerOrder[]}[] }).pages.flatMap((p)=>p.data),
  });
}

export function useSellerOrderQuery(orderId: string, enabled=true) {
  const bid = useBusinessId();
  return useQuery({
    queryKey: SELLER_KEYS.order(orderId, bid),
    queryFn: async () => {
      if (!bid) throw new Error("No business");
      const order = await getLocalOrder(bid, orderId);
      if (!order) throw new Error("Order not found");
      return { data: order };
    },
    enabled: enabled && !!orderId && !!bid,
    staleTime: 5*1000,
  });
}

export function useCreatePOSOrderMutation() {
  const bid = useBusinessId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: POSOrderCreateRequest) => {
      if (!bid) throw new Error("No business");
      const dn = getDeviceNumber(bid);
      if (!dn) { const leased = await ensureLease(bid); if (!leased) throw new Error("No device number leased — connect online once"); }
      // Engine route: cloud → LAN node → queue. Never createLocalOrder
      // directly — it bypasses sync and peers never see the order.
      return orderRepository.createOrder({ businessId: bid, data, entityId: generateUUID() });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: POS_KEYS.orders(bid) }); qc.invalidateQueries({ queryKey: SELLER_KEYS.all }); qc.invalidateQueries({ queryKey: SELLER_DASHBOARD_KEYS.all }); },
  });
}

function cartHash(items: POSCartItem[]): string { return items.map((i)=>`${i.menu_item.id}:${i.quantity}:${i.selected_variant?.id||""}:${(i.selected_addons||[]).map((a)=>a.addon_id).sort().join(",")}`).join("|"); }

export function usePOSOrderPreviewQuery(items: POSCartItem[], orderType: POSOrderType, customerName: string) {
  const bid = useBusinessId();
  const hash = cartHash(items);
  return useQuery({
    queryKey: [...POS_KEYS.preview(bid), hash, orderType, customerName],
    queryFn: async () => {
      const orderItems: POSOrderItemRequest[] = items.map((i)=>({ menu_item_id: i.menu_item.id, quantity: i.quantity, variant_id: i.selected_variant?.id, addon_ids: i.selected_addons.length>0?i.selected_addons.map((a)=>a.addon_id):undefined }));
      try {
        return await posRepository.fetchPreview({ businessId: bid!, items: orderItems, orderType, customerName: customerName||undefined });
      } catch {
        const db = await openSyncDatabase();
        const taxRec = await getReferenceData<{ data: unknown[] }>(db, bid!, "tax-rules");
        const taxRules = (taxRec?.payload as { data?: unknown[] })?.data as unknown[] ?? [];
        const pricing = calculatePricing({ items: items as unknown as Parameters<typeof calculatePricing>[0]["items"], taxRules: taxRules as unknown as Parameters<typeof calculatePricing>[0]["taxRules"] });
        return { data: { subtotal_minor: pricing.subtotal_minor, discount_minor: pricing.discount_minor, delivery_fee_minor: pricing.delivery_fee_minor, tax_minor: pricing.tax_minor, tip_minor: pricing.tip_minor, total_minor: pricing.total_minor, tax_lines: pricing.tax_lines, currency: pricing.currency_code } } as unknown as POSOrderPreviewResponse;
      }
    },
    enabled: !!bid && items.length>0,
    staleTime: 30*1000,
  });
}

function makeOrderActionMutation(build: (p:{orderId:string;businessId:string})=>Promise<unknown>) {
  return function useOrderActionMutation() {
    const bid = useBusinessId();
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (orderId: string) => {
        if (!bid) throw new Error("No active business");
        return build({ orderId, businessId: bid });
      },
      onSuccess: (_d,_e, orderId) => { qc.invalidateQueries({ queryKey: SELLER_KEYS.all }); qc.invalidateQueries({ queryKey: POS_KEYS.all }); qc.invalidateQueries({ queryKey: SELLER_DASHBOARD_KEYS.all }); if(orderId) qc.invalidateQueries({ queryKey: SELLER_KEYS.order(orderId as string) }); },
    });
  };
}

export const useAcceptOrderMutation = makeOrderActionMutation(({orderId,businessId}) => orderRepository.acceptOrder({orderId,businessId}));
export const useRejectOrderMutation = makeOrderActionMutation(({orderId,businessId}) => orderRepository.rejectOrder({orderId,businessId}));
export const useStartPreparingOrderMutation = makeOrderActionMutation(({orderId,businessId}) => orderRepository.startPreparingOrder({orderId,businessId}));
export const useMarkOrderReadyMutation = makeOrderActionMutation(({orderId,businessId}) => orderRepository.markOrderReady({orderId,businessId}));
export const useCompletePickupMutation = makeOrderActionMutation(({orderId,businessId}) => orderRepository.completePickup({orderId,businessId}));
export const useCancelOrderMutation = makeOrderActionMutation(({orderId,businessId}) => orderRepository.cancelOrder({orderId,businessId}));
export function useConfirmHandoverMutation() {
  const bid = useBusinessId(); const qc = useQueryClient();
  return useMutation({ mutationFn: (deliveryId: string) => { if(!bid) throw new Error("No business"); return orderRepository.confirmHandover({deliveryId,businessId:bid}); }, onSuccess: ()=>{ qc.invalidateQueries({ queryKey: SELLER_KEYS.all }); qc.invalidateQueries({ queryKey: POS_KEYS.all }); qc.invalidateQueries({ queryKey: SELLER_DASHBOARD_KEYS.all }); }});
}
export function useAssignRiderMutation() {
  const bid = useBusinessId(); const qc = useQueryClient();
  return useMutation({ mutationFn: ({orderId,riderId}:{orderId:string;riderId:string})=>{ if(!bid) throw new Error("No business"); const s = getConnectivityState(); if(!s.isOnline || s.isCloudReachable === "unreachable") throw new Error("Assign rider requires online"); return orderRepository.assignRider({orderId,riderId,businessId:bid}); }, onSuccess: ()=>{ qc.invalidateQueries({ queryKey: SELLER_KEYS.all }); qc.invalidateQueries({ queryKey: SELLER_DASHBOARD_KEYS.all }); }});
}
export function useConfirmCashPaymentMutation() {
  const bid = useBusinessId(); const qc = useQueryClient();
  return useMutation({ mutationFn: (orderId:string)=>{ if(!bid) throw new Error("No business"); return orderRepository.confirmCashPayment({orderId,businessId:bid}); }, onSuccess: (_d,_e,orderId)=>{ qc.invalidateQueries({ queryKey: SELLER_KEYS.all }); qc.invalidateQueries({ queryKey: POS_KEYS.all }); qc.invalidateQueries({ queryKey: SELLER_DASHBOARD_KEYS.all }); if(orderId) qc.invalidateQueries({ queryKey: SELLER_KEYS.order(orderId as string)}); }});
}
export function useUpdateOrderStatusMutation() { const accept=useAcceptOrderMutation(); const reject=useRejectOrderMutation(); const preparing=useStartPreparingOrderMutation(); const ready=useMarkOrderReadyMutation(); const complete=useCompletePickupMutation(); const cancel=useCancelOrderMutation(); return { mutate: (orderId:string,status:string)=>{ const s=String(status); if(!["accepted","preparing","ready","delivered","cancelled","rejected"].includes(s)) throw new Error(`Unknown status ${s}`); switch(s){case "accepted":return accept.mutateAsync(orderId);case "preparing":return preparing.mutateAsync(orderId);case "ready":return ready.mutateAsync(orderId);case "delivered":return complete.mutateAsync(orderId);case "cancelled":return cancel.mutateAsync(orderId);case "rejected":return reject.mutateAsync(orderId);default:throw new Error(`Unknown status ${s}`);} }, isPending: accept.isPending||reject.isPending||preparing.isPending||ready.isPending||complete.isPending||cancel.isPending, }; }
export function isQueuedTransition(result: unknown): boolean { const r=result as {status?:string;command_id?:string;id?:string}|null; return !!r && r.status==="pending" && !!r.command_id && !r.id; }

/**
 * Reactive view of locally queued (unconfirmed) order creations.
 * Hydrates persisted optimistic events once (survives restart offline).
 */
export function usePendingOrders(): SellerOrder[] {
  const snap = useSyncExternalStore(
    subscribePendingOrders,
    () => getPendingOrdersSnapshot().orders,
    () => [],
  );
  useEffect(() => {
    if (!getPendingOrdersSnapshot().hydrated) {
      hydratePendingOrders().catch(() => undefined);
    }
  }, []);
  return snap;
}
