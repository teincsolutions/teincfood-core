/**
 * Business deliveries hooks — single source for both apps.
 * Offline-first: local orders with delivery_id serve instantly; the network
 * refreshes silently when online.
 */

import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { deliveryService } from "../adapters/services";
import { listLocalOrders } from "../domain/orders/service";
import type { BusinessDelivery } from "../types/api/seller.api";
import { useInfiniteList, useIsEffectivelyOnline, type ListPage } from "./use-infinite-list";

export const DELIVERY_KEYS = {
  all: ["business-deliveries"] as const,
  list: (businessId?: string, filters?: Record<string, unknown>) => ["business-deliveries", businessId, filters] as const,
};

export const DELIVERY_DETAIL_KEYS = {
  all: ["delivery"] as const,
  detail: (id: string) => [...DELIVERY_DETAIL_KEYS.all, "detail", id] as const,
};

export function useDeliveryDetailQuery(deliveryId: string, enabled = true) {
  // No single-delivery SQLite mirror (list derives from local orders) —
  // never fire while unreachable; persisted cache serves instead.
  const online = useIsEffectivelyOnline();
  return useQuery({
    queryKey: DELIVERY_DETAIL_KEYS.detail(deliveryId),
    queryFn: () => deliveryService.fetchDeliveryDetail(deliveryId),
    enabled: enabled && Boolean(deliveryId) && online,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

function useBusinessId(): string | undefined {
  const id = useSyncExternalStore(subscribeBusiness, () => getActiveBusiness()?.id ?? null, () => null);
  return id ?? undefined;
}

export interface DeliveryFilters {
  status?: string;
  search?: string;
  order_type?: string;
  is_paid?: string;
  date_from?: string;
  date_to?: string;
}

async function fetchOfflineDeliveries(
  businessId: string,
  filters: DeliveryFilters | undefined,
  page: number,
  pageSize: number,
): Promise<ListPage<BusinessDelivery>> {
  const { data } = await listLocalOrders(
    businessId,
    {
      status: undefined,
      q: filters?.search,
      order_type: filters?.order_type,
      is_paid: filters?.is_paid,
      date_from: filters?.date_from,
      date_to: filters?.date_to,
    },
    page,
    pageSize,
  );
  const deliveryOrders = (data as unknown as { delivery_id?: string | null }[]).filter((o) => o.delivery_id);
  const statusSet = new Set((filters?.status ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const filtered =
    statusSet.size > 0
      ? deliveryOrders.filter((o) => statusSet.has(((o as unknown as { status: string }).status ?? "")))
      : deliveryOrders;
  const total = filtered.length;
  const items = filtered.slice((page - 1) * pageSize, page * pageSize);
  const mapped = items.map((o) => {
    const order = o as unknown as Record<string, unknown>;
    return {
      id: (order.delivery_id as string) ?? (order.id as string),
      status: (order as unknown as { delivery_status?: string }).delivery_status ?? "assigned",
      inserted_at: order.inserted_at,
      rider: (order as unknown as { rider?: unknown }).rider ?? null,
      order,
      merchant_handover_confirmed_at: null,
      rider_pickup_confirmed_at: null,
    };
  });
  return {
    data: mapped as unknown as BusinessDelivery[],
    pagination: { page, page_size: pageSize, total_pages: Math.max(1, Math.ceil(total / pageSize)), total_entries: total },
  };
}

export function useBusinessDeliveriesQuery(enabled = true, filters?: DeliveryFilters) {
  const businessId = useBusinessId();
  return useInfiniteList<BusinessDelivery>({
    key: DELIVERY_KEYS.list(businessId, filters as Record<string, unknown> | undefined),
    enabled: enabled && Boolean(businessId),
    pageSize: 20,
    staleTime: 5_000,
    offlineFetch: (page, pageSize) => fetchOfflineDeliveries(businessId!, filters, page, pageSize),
    onlineFetch: async (page, pageSize) => {
      const params: Record<string, unknown> = { page, page_size: pageSize };
      if (filters?.status) params.status = filters.status;
      if (filters?.search) params.search = filters.search;
      if (filters?.order_type) params.order_type = filters.order_type;
      if (filters?.is_paid) params.payment_status = filters.is_paid;
      if (filters?.date_from) params.date_from = filters.date_from;
      if (filters?.date_to) params.date_to = filters.date_to;
      const res = (await deliveryService.fetchBusinessDeliveries(businessId!, params)) as {
        data: BusinessDelivery[];
        pagination: { page: number; page_size: number; total_pages: number; total_entries?: number };
      };
      return res;
    },
  });
}
