/**
 * Seller dashboard hooks — single source for both apps.
 * Offline-first: local SQLite aggregates serve instantly; the network
 * refreshes silently when online.
 */

import { useQuery } from "@tanstack/react-query";
import { dashboardService } from "../adapters/services";
import { listLocalOrders } from "../domain/orders/service";
import { useIsEffectivelyOnline } from "./use-infinite-list";
import type { SellerDashboardMetrics, SellerDashboardResponse } from "../types/api/seller.api";

export const SELLER_DASHBOARD_KEYS = {
  all: ["seller-dashboard"] as const,
  metrics: (businessId?: string) => [...SELLER_DASHBOARD_KEYS.all, "metrics", businessId] as const,
  recentOrders: (businessId?: string) => [...SELLER_DASHBOARD_KEYS.all, "recent-orders", businessId] as const,
  full: (businessId?: string) => [...SELLER_DASHBOARD_KEYS.all, "full", businessId] as const,
};

const EMPTY_METRICS: SellerDashboardMetrics = {
  today_orders: 0,
  today_revenue_minor: 0,
  pending_orders: 0,
  active_orders: 0,
  average_rating: 0,
};

interface LocalOrderRow {
  status: string;
  total_minor: number;
  inserted_at: string;
  order_number: string;
  id: string;
}

/**
 * Local SQLite aggregates — instant, even online. Single source for all
 * three dashboard queries so metrics/recent/full never diverge.
 */
async function computeLocalDashboard(businessId: string): Promise<{
  metrics: SellerDashboardMetrics;
  recent_orders: SellerDashboardResponse["data"]["recent_orders"];
}> {
  const { data } = await listLocalOrders(businessId, {}, 1, 200);
  const orders = ((data as unknown as LocalOrderRow[]) ?? []);
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayOrders = orders.filter((o) => (o.inserted_at ?? "").slice(0, 10) === todayStr);
  const todayRevenue = todayOrders.reduce((sum, o) => sum + (o.total_minor ?? 0), 0);
  const pending = orders.filter((o) => ["pending", "awaiting_payment", "accepted"].includes(o.status)).length;
  const active = orders.filter((o) => !["delivered", "cancelled", "rejected"].includes(o.status)).length;
  const recent = [...orders]
    .sort((a, b) => (b.inserted_at ?? "").localeCompare(a.inserted_at ?? ""))
    .slice(0, 5)
    .map((o) => ({ id: o.id, order_number: o.order_number, status: o.status, total_minor: o.total_minor, item_count: 1 }));
  return {
    metrics: { today_orders: todayOrders.length, today_revenue_minor: todayRevenue, pending_orders: pending, active_orders: active, average_rating: 0 },
    recent_orders: recent,
  };
}

export function useSellerDashboardMetricsQuery(businessId: string, enabled = true) {
  const online = useIsEffectivelyOnline();
  return useQuery({
    queryKey: SELLER_DASHBOARD_KEYS.metrics(businessId),
    queryFn: async () => {
      // DB first — instant, even online.
      let local: SellerDashboardMetrics | null = null;
      try {
        local = (await computeLocalDashboard(businessId)).metrics;
      } catch {}
      if (!online) return local ?? EMPTY_METRICS;
      try {
        const res = (await dashboardService.fetchSellerDashboard(businessId)) as SellerDashboardResponse;
        return res.data.metrics ?? local ?? EMPTY_METRICS;
      } catch {
        return local ?? EMPTY_METRICS;
      }
    },
    enabled: enabled && Boolean(businessId),
    staleTime: 1000 * 60 * 2,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

export function useSellerDashboardRecentOrdersQuery(businessId: string, enabled = true) {
  const online = useIsEffectivelyOnline();
  return useQuery({
    queryKey: SELLER_DASHBOARD_KEYS.recentOrders(businessId),
    queryFn: async () => {
      // DB first — instant, even online.
      let local: SellerDashboardResponse["data"]["recent_orders"] = [];
      try {
        local = (await computeLocalDashboard(businessId)).recent_orders;
      } catch {}
      if (!online) return local;
      try {
        const res = (await dashboardService.fetchSellerDashboard(businessId)) as SellerDashboardResponse;
        return local.length > 0 ? local : res.data.recent_orders;
      } catch {
        return local;
      }
    },
    enabled: enabled && Boolean(businessId),
    staleTime: 1000 * 60 * 2,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

export function useSellerDashboardQuery(businessId: string, enabled = true) {
  const online = useIsEffectivelyOnline();
  return useQuery({
    queryKey: SELLER_DASHBOARD_KEYS.full(businessId),
    queryFn: async () => {
      // Local SQLite aggregates first — instant, even online.
      let localRecent: SellerDashboardResponse["data"]["recent_orders"] = [];
      let localMetrics: SellerDashboardMetrics | null = null;
      try {
        const local = await computeLocalDashboard(businessId);
        localRecent = local.recent_orders;
        localMetrics = local.metrics;
      } catch {}
      if (!online) {
        return { metrics: localMetrics ?? EMPTY_METRICS, recent_orders: localRecent };
      }
      try {
        const res = (await dashboardService.fetchSellerDashboard(businessId)) as SellerDashboardResponse;
        const backend = res.data;
        return {
          metrics: backend.metrics ?? localMetrics,
          recent_orders: localRecent.length > 0 ? localRecent : backend.recent_orders,
        };
      } catch {
        return { metrics: localMetrics ?? EMPTY_METRICS, recent_orders: localRecent };
      }
    },
    enabled: enabled && Boolean(businessId),
    staleTime: 30 * 1000,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}
