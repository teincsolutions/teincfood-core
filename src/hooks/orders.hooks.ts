/**
 * Order lifecycle hooks — offline-first, device-owned outbox.
 *
 * Device owns its partition: when offline it serves the durable
 * entity_snapshots + pending overlay immediately; the SyncEngine replays
 * queued commands when back online. No hook ever blocks on a cloud timeout
 * when offline.
 *
 * Host apps just re-export from "@teincfood/core" — no app-local duplication.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { posRepository } from "../repositories/pos.repository";
import { orderRepository } from "../repositories/order.repository";
import { sellerService } from "../adapters/services";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { getConnectivityState, subscribeConnectivity } from "../adapters/connectivity";
import {
  getPendingOrdersSnapshot,
  subscribePendingOrders,
  usePendingOrdersStore,
} from "../adapters/pending-orders";
import { orderSnapshotsService } from "../sync/order-snapshots.service";
import { hydratePendingOrders } from "../sync/pending-orders.service";
import { isLocalOrderNumber } from "../sync/order-number";
import { filterOrdersOffline, paginateOffline } from "../utils/order-filter";
import type { POSOrderCreateRequest, POSOrderPreviewResponse } from "../types/pos.types";
import type { POSCartItem, POSOrderType, POSOrderItemRequest } from "../types/pos.types";
import type { SellerOrder } from "../types/api/seller.api";

// ─── Keys (host apps should import from core, not define their own) ─────

export const POS_KEYS = {
  all: ["pos"] as const,
  orders: (businessId?: string) => ["pos", "orders", businessId] as const,
  preview: (businessId?: string) => ["pos", "preview", businessId] as const,
} as const;

export const SELLER_KEYS = {
  all: ["seller"] as const,
  orders: (businessId?: string, filters?: Record<string, unknown>) =>
    [...SELLER_KEYS.all, "orders", businessId, filters].filter((x) => x !== undefined) as readonly unknown[],
  deliveries: (businessId?: string, filters?: Record<string, unknown>) =>
    [...SELLER_KEYS.all, "deliveries", businessId, filters].filter((x) => x !== undefined) as readonly unknown[],
  order: (id: string, businessId?: string) => [...SELLER_KEYS.all, "order", id, businessId] as const,
} as const;

// ─── Helpers ───────────────────────────────────────────────────────────────

function useBusinessId(): string | undefined {
  const id = useSyncExternalStore(
    subscribeBusiness,
    () => getActiveBusiness()?.id ?? null,
    () => null,
  );
  return id ?? undefined;
}

function useConnectivity() {
  const state = useSyncExternalStore(subscribeConnectivity, getConnectivityState, getConnectivityState);
  return state;
}

function useCorePendingOrders(businessId?: string): SellerOrder[] {
  const snap = useSyncExternalStore(subscribePendingOrders, getPendingOrdersSnapshot, getPendingOrdersSnapshot);
  useEffect(() => {
    if (snap.hydrated) return;
    hydratePendingOrders().catch(() => {});
  }, [snap.hydrated]);
  return useMemo(
    () => (businessId ? snap.orders.filter((o) => (o as unknown as { business_id?: string }).business_id === businessId) : snap.orders),
    [snap.orders, businessId],
  );
}

function mergePendingOrders(pending: SellerOrder[], serverOrders: SellerOrder[] | undefined): SellerOrder[] {
  if (pending.length === 0) return serverOrders ?? [];
  const seen = new Set<string>();
  const merged: SellerOrder[] = [];
  for (const order of pending) {
    seen.add(order.order_number);
    merged.push(order);
  }
  for (const order of serverOrders ?? []) {
    if (!seen.has(order.order_number)) merged.push(order);
  }
  return merged.sort((a, b) => (b.inserted_at ?? "").localeCompare(a.inserted_at ?? ""));
}

function isOfflineState(s: ReturnType<typeof getConnectivityState>): boolean {
  return !s.isOnline || s.isCloudReachable === "unreachable";
}

// ─── POS Orders Query (offline-first) ─────────────────────────────────────

export function usePOSOrdersQuery(
  filters?: {
    status?: string;
    order_type?: string;
    is_pos?: string;
    date_from?: string;
    date_to?: string;
    q?: string;
    search?: string;
  },
  enabled = true,
) {
  const businessId = useBusinessId();
  const pendingOrders = useCorePendingOrders(businessId);
  const connectivity = useConnectivity();
  const offline = isOfflineState(connectivity);

  const query = useInfiniteQuery({
    queryKey: [...POS_KEYS.orders(businessId), filters],
    queryFn: async ({ pageParam = 1 }) => {
      const params: Record<string, string> = { page: String(pageParam) };
      if (filters?.status) params.status = filters.status;
      if (filters?.order_type) params.order_type = filters.order_type;
      if (filters?.is_pos) params.is_pos = filters.is_pos;
      if (filters?.date_from) params.date_from = filters.date_from;
      if (filters?.date_to) params.date_to = filters.date_to;
      if (filters?.q) params.q = filters.q;
      if (filters?.search) params.search = filters.search;

      if (offline) {
        const offlineList = businessId ? await orderSnapshotsService.getSellerList(businessId, businessId) : null;
        const base = offlineList ?? [];
        const filtered = filterOrdersOffline(base as SellerOrder[], filters as any);
        // date_from/to are handled inside filterSellerOrders via inserted_at; apply if present
        const paged = paginateOffline(filtered as SellerOrder[], pageParam as number, 20);
        return paged as unknown as { data: SellerOrder[]; pagination: { page: number; total_pages: number } };
      }

      try {
        const result = (await posRepository.fetchOrders(businessId!, params)) as unknown as {
          data: SellerOrder[];
          pagination: { page: number; total_pages: number };
        };
        if (pageParam === 1 && businessId && Array.isArray((result as unknown as { data: unknown[] }).data)) {
          orderSnapshotsService.persistSellerOrders(businessId, businessId, (result as unknown as { data: SellerOrder[] }).data).catch(() => {});
        }
        return result;
      } catch (e) {
        const offlineList = businessId ? await orderSnapshotsService.getSellerList(businessId, businessId) : null;
        if (offlineList) {
          const filtered = filterOrdersOffline(offlineList as SellerOrder[], filters as any);
          const paged = paginateOffline(filtered as SellerOrder[], pageParam as number, 20);
          return paged as unknown as { data: SellerOrder[]; pagination: { page: number; total_pages: number } };
        }
        throw e;
      }
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const p = (lastPage as unknown as { pagination?: { page: number; total_pages: number } }).pagination;
      return p && p.page < p.total_pages ? p.page + 1 : undefined;
    },
    enabled: enabled && !!businessId,
    staleTime: 30 * 1000,
    retry: false,
    networkMode: "offlineFirst" as const,
    select: (data) => (data as unknown as { pages: { data: SellerOrder[] }[] }).pages.flatMap((p) => p.data),
  });

  const data = useMemo(() => mergePendingOrders(pendingOrders, query.data as unknown as SellerOrder[] | undefined), [pendingOrders, query.data]);

  return { ...query, data } as typeof query & { data: SellerOrder[] | undefined };
}

// ─── Seller Orders Query (offline-first, shares same snapshot) ────────────

export function useSellerOrdersQuery(
  enabled = true,
  filters?: { status?: string; q?: string; search?: string; date_from?: string; date_to?: string },
) {
  const businessId = useBusinessId();
  const pendingOrders = useCorePendingOrders(businessId);
  const connectivity = useConnectivity();
  const offline = isOfflineState(connectivity);

  const query = useInfiniteQuery({
    queryKey: SELLER_KEYS.orders(businessId, filters as Record<string, unknown>),
    queryFn: async ({ pageParam = 1 }) => {
      const params: Record<string, unknown> = { page: pageParam, page_size: 20 };
      if (filters?.status) (params as Record<string, string>).status = filters.status;
      if (filters?.q) (params as Record<string, string>).q = filters.q;
      if (filters?.search) (params as Record<string, string>).search = filters.search;
      if ((filters as Record<string, string>)?.date_from) (params as Record<string, string>).date_from = (filters as Record<string, string>).date_from;
      if ((filters as Record<string, string>)?.date_to) (params as Record<string, string>).date_to = (filters as Record<string, string>).date_to;

      if (offline) {
        const offlineList = businessId ? await orderSnapshotsService.getSellerList(businessId, businessId) : null;
        const base = offlineList ?? [];
        const filtered = filterOrdersOffline(base as SellerOrder[], filters as any);
        const paged = paginateOffline(filtered as SellerOrder[], pageParam as number, 20);
        return paged as unknown as { data: SellerOrder[]; pagination: { page: number; total_pages: number } };
      }

      try {
        const result = (await sellerService.fetchBusinessOrders(businessId!, params)) as unknown as {
          data: SellerOrder[];
          pagination: { page: number; total_pages: number };
        };
        if (pageParam === 1 && businessId && Array.isArray((result as unknown as { data: unknown[] }).data)) {
          orderSnapshotsService.persistSellerOrders(businessId, businessId, (result as unknown as { data: SellerOrder[] }).data).catch(() => {});
        }
        return result;
      } catch (e) {
        const offlineList = businessId ? await orderSnapshotsService.getSellerList(businessId, businessId) : null;
        if (offlineList) {
          const filtered = filterOrdersOffline(offlineList as SellerOrder[], filters as any);
          const paged = paginateOffline(filtered as SellerOrder[], pageParam as number, 20);
          return paged as unknown as { data: SellerOrder[]; pagination: { page: number; total_pages: number } };
        }
        throw e;
      }
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      const p = (lastPage as unknown as { pagination?: { page: number; total_pages: number } }).pagination;
      return p && p.page < p.total_pages ? p.page + 1 : undefined;
    },
    enabled: enabled && !!businessId,
    staleTime: 30 * 1000,
    retry: false,
    networkMode: "offlineFirst" as const,
    select: (data) => (data as unknown as { pages: { data: SellerOrder[] }[] }).pages.flatMap((p) => p.data),
  });

  const data = useMemo(() => mergePendingOrders(pendingOrders, query.data as unknown as SellerOrder[] | undefined), [pendingOrders, query.data]);

  return { ...query, data } as typeof query & { data: SellerOrder[] | undefined };
}

// ─── Pending orders hook (for screens that just need the overlay) ─────────

export function usePendingOrders(businessId?: string): SellerOrder[] {
  return useCorePendingOrders(businessId);
}

// ─── Create POS Order (device-lease aware, via SyncEngine) ────────────────

export function useCreatePOSOrderMutation() {
  const businessId = useBusinessId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: POSOrderCreateRequest) => {
      const { isOnline, isCloudReachable } = getConnectivityState();
      if (!businessId) throw new Error("Missing business — select a business before creating orders");
      try {
        const m = await import("../sync/device-lease.service");
        const dn = (m as unknown as { getDeviceNumber?: (id: string) => string | null }).getDeviceNumber?.(businessId) ?? null;
        if (!dn) {
          const leased = await (m as unknown as { ensureDeviceLease?: (id: string) => Promise<boolean> }).ensureDeviceLease?.(businessId);
          if (!leased && (!isOnline || isCloudReachable === "unreachable")) {
            throw new Error("No device number leased (99 devices max) — cannot create offline orders");
          }
        }
      } catch (e) {
        if ((e as Error)?.message?.includes("device number") || (e as Error)?.message?.includes("No device lease")) throw e;
      }
      return posRepository.createOrder(businessId, data);
    },
    onSuccess: (result: unknown) => {
      const r = result as { order_number?: string; status?: string } | undefined;
      const orderNumber = r?.order_number ?? "";
      const queued = orderNumber ? isLocalOrderNumber(orderNumber) && r?.status === "pending" : false;
      queryClient.invalidateQueries({ queryKey: POS_KEYS.orders(businessId) });
      queryClient.invalidateQueries({ queryKey: SELLER_KEYS.orders(businessId as string) });
      queryClient.invalidateQueries({ queryKey: SELLER_KEYS.all });
      // Toast is host concern — core just invalidates; host can show queued vs created.
      void queued;
    },
  });
}

// ─── Preview (offline via tax-rules reference) ────────────────────────────

function cartHash(items: POSCartItem[]): string {
  if (items.length === 0) return "";
  return items
    .map((i) => `${i.menu_item.id}:${i.quantity}:${i.selected_variant?.id || ""}:${(i.selected_addons || []).map((a) => a.addon_id).sort().join(",")}`)
    .join("|");
}

export function usePOSOrderPreviewQuery(items: POSCartItem[], orderType: POSOrderType, customerName: string) {
  const businessId = useBusinessId();
  const hash = useMemo(() => cartHash(items), [items]);
  return useQuery({
    queryKey: [...POS_KEYS.preview(businessId), hash, orderType, customerName],
    queryFn: async () => {
      const orderItems: POSOrderItemRequest[] = items.map((i) => ({
        menu_item_id: i.menu_item.id,
        quantity: i.quantity,
        variant_id: i.selected_variant?.id,
        addon_ids: i.selected_addons.length > 0 ? i.selected_addons.map((a) => a.addon_id) : undefined,
      }));
      try {
        return await posRepository.fetchPreview({ businessId: businessId!, items: orderItems, orderType, customerName: customerName || undefined });
      } catch (e) {
        const s = getConnectivityState();
        const isOffline = !s.isOnline || s.isCloudReachable === "unreachable";
        if (!isOffline) throw e;
        const { openSyncDatabase } = await import("../db/connection");
        const { getReferenceData } = await import("../reference/operations");
        const { calculatePricing } = await import("../pricing/engine");
        const db = await openSyncDatabase();
        const taxRec = await getReferenceData<{ data: unknown[] }>(db, businessId!, "tax-rules");
        const taxRules = (taxRec?.payload as { data?: unknown[] })?.data as unknown[] ?? [];
        const pricing = calculatePricing({ items: items as unknown as Parameters<typeof calculatePricing>[0]["items"], taxRules: taxRules as unknown as Parameters<typeof calculatePricing>[0]["taxRules"] });
        return { data: { subtotal_minor: pricing.subtotal_minor, discount_minor: pricing.discount_minor, delivery_fee_minor: pricing.delivery_fee_minor, tax_minor: pricing.tax_minor, tip_minor: pricing.tip_minor, total_minor: pricing.total_minor, tax_lines: pricing.tax_lines, currency: pricing.currency_code } } as unknown as POSOrderPreviewResponse;
      }
    },
    enabled: !!businessId && items.length > 0,
    staleTime: 30 * 1000,
  });
}

// ─── Order status mutations via SyncEngine (all go through outbox) ────────

function makeOrderActionMutation(
  build: (p: { orderId: string; businessId: string }) => Promise<unknown>,
) {
  return function useOrderActionMutation() {
    const businessId = useBusinessId();
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: (orderId: string) => {
        if (!businessId) throw new Error("No active business");
        return build({ orderId, businessId });
      },
      onSettled: (_d, _e, orderId) => {
        queryClient.invalidateQueries({ queryKey: SELLER_KEYS.orders() });
        queryClient.invalidateQueries({ queryKey: POS_KEYS.orders(businessId) });
        if (orderId) queryClient.invalidateQueries({ queryKey: SELLER_KEYS.order(orderId as string) });
      },
    });
  };
}

export const useAcceptOrderMutation = makeOrderActionMutation(({ orderId, businessId }) => orderRepository.acceptOrder({ orderId, businessId }));
export const useRejectOrderMutation = makeOrderActionMutation(({ orderId, businessId }) => orderRepository.rejectOrder({ orderId, businessId }));
export const useStartPreparingOrderMutation = makeOrderActionMutation(({ orderId, businessId }) => orderRepository.startPreparingOrder({ orderId, businessId }));
export const useMarkOrderReadyMutation = makeOrderActionMutation(({ orderId, businessId }) => orderRepository.markOrderReady({ orderId, businessId }));
export const useCompletePickupMutation = makeOrderActionMutation(({ orderId, businessId }) => orderRepository.completePickup({ orderId, businessId }));
export const useCancelOrderMutation = makeOrderActionMutation(({ orderId, businessId }) => orderRepository.cancelOrder({ orderId, businessId }));
