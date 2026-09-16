/**
 * Seller analytics hooks — single source for both apps.
 * Offline-first: local SQLite aggregates serve instantly; the network
 * refreshes silently when online.
 */

import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { analyticsService } from "../adapters/services";
import { listLocalOrders } from "../domain/orders/service";
import { useIsEffectivelyOnline } from "./use-infinite-list";

export const SELLER_ANALYTICS_KEYS = {
  all: ["seller-analytics"] as const,
  analytics: (businessId?: string, period?: string) => [...SELLER_ANALYTICS_KEYS.all, businessId, period] as const,
};

export const REVENUE_KEYS = {
  all: ["revenue-summary"] as const,
  summary: (businessId?: string, period?: string) => [...REVENUE_KEYS.all, businessId, period] as const,
};

function useBusinessId(): string | undefined {
  const id = useSyncExternalStore(subscribeBusiness, () => getActiveBusiness()?.id ?? null, () => null);
  return id ?? undefined;
}

const OFFLINE_FIRST = { retry: false, networkMode: "offlineFirst" } as const;

interface LocalOrderRow {
  status: string;
  total_minor: number;
  subtotal_minor?: number;
  inserted_at: string;
  payment_mode?: string;
  pos_payment_method?: string;
  order_type?: string;
  items?: Array<{
    quantity?: number;
    subtotal?: number;
    total_price_minor?: number;
    menu_item?: { name?: string };
  }>;
}

interface AggregateOptions {
  forRevenueSummary: boolean;
}

/**
 * Backend-shaped aggregates computed from local SQLite rows (offline).
 * Field names mirror orders.ex get_seller_analytics / get_revenue_summary
 * exactly so screens render identically online and offline.
 */
function filterByPeriod(orders: LocalOrderRow[], period: "today" | "this_week" | "this_month"): LocalOrderRow[] {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  if (period === "today") {
    return orders.filter((o) => (o.inserted_at ?? "").slice(0, 10) === todayStr);
  }
  if (period === "this_week") {
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay()); // Sunday
    const startStr = startOfWeek.toISOString().slice(0, 10);
    return orders.filter((o) => {
      const d = (o.inserted_at ?? "").slice(0, 10);
      return d >= startStr && d <= todayStr;
    });
  }
  // this_month
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startStr = startOfMonth.toISOString().slice(0, 10);
  return orders.filter((o) => {
    const d = (o.inserted_at ?? "").slice(0, 10);
    return d >= startStr && d <= todayStr;
  });
}

export function aggregateLocal(orders: LocalOrderRow[], period: "today" | "this_week" | "this_month", opts: AggregateOptions) {
  const filtered = filterByPeriod(orders, period);
  // Backend parity (orders.ex get_business_analytics / get_revenue_summary):
  // revenue-eligible = all EXCEPT cancelled. Cancelled orders must never
  // inflate revenue, counts, breakdowns, or top items — online and offline.
  const revenueOrders = filtered.filter((o) => o.status !== "cancelled");
  const total_revenue_minor = revenueOrders.reduce((s, o) => s + (o.total_minor ?? 0), 0);
  const total_orders = revenueOrders.length;
  // Backend uses div (truncation) — mirror, don't round.
  const average_order_value_minor = total_orders ? Math.floor(total_revenue_minor / total_orders) : 0;
  const byMethod = new Map<string, { revenue_minor: number; count: number }>();
  const byType = new Map<string, { revenue_minor: number; count: number }>();
  const byDay = new Map<string, { revenue_minor: number; count: number }>();
  const itemQty = new Map<string, number>();
  const itemRev = new Map<string, number>();
  for (const o of revenueOrders) {
    const method = o.pos_payment_method ?? o.payment_mode ?? "cash";
    const m = byMethod.get(method) ?? { revenue_minor: 0, count: 0 };
    m.revenue_minor += o.total_minor ?? 0;
    m.count += 1;
    byMethod.set(method, m);
    const t = o.order_type ?? "takeout";
    const ty = byType.get(t) ?? { revenue_minor: 0, count: 0 };
    ty.revenue_minor += o.total_minor ?? 0;
    ty.count += 1;
    byType.set(t, ty);
    const day = (o.inserted_at ?? "").slice(0, 10);
    const d = byDay.get(day) ?? { revenue_minor: 0, count: 0 };
    d.revenue_minor += o.total_minor ?? 0;
    d.count += 1;
    byDay.set(day, d);
    for (const it of o.items ?? []) {
      const name = it.menu_item?.name ?? "Unknown";
      const qty = it.quantity ?? 0;
      const rev = it.subtotal ?? it.total_price_minor ?? 0;
      itemQty.set(name, (itemQty.get(name) ?? 0) + qty);
      itemRev.set(name, (itemRev.get(name) ?? 0) + rev);
    }
  }
  const pct = (v: number) => (total_revenue_minor > 0 ? Math.round((v / total_revenue_minor) * 1000) / 10 : 0);
  // Backend orders_by_status counts over ALL period orders (not revenue-only).
  const orders_by_status = {
    delivered: filtered.filter((o) => o.status === "delivered").length,
    cancelled: filtered.filter((o) => o.status === "cancelled").length,
    pending: filtered.filter((o) => o.status === "pending").length,
  };
  if (opts.forRevenueSummary) {
    return {
      period,
      total_revenue_minor,
      total_orders,
      average_order_value_minor,
      by_payment_method: [...byMethod.entries()]
        .map(([method, v]) => ({ method, ...v, percentage: pct(v.revenue_minor) }))
        .sort((a, b) => b.revenue_minor - a.revenue_minor),
      by_order_type: [...byType.entries()]
        .map(([type, v]) => ({ type, ...v }))
        .sort((a, b) => b.revenue_minor - a.revenue_minor),
      by_day: [...byDay.entries()]
        .map(([date, v]) => ({ date, ...v }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      offline: true,
    };
  }
  return {
    period,
    total_revenue_minor,
    total_orders,
    average_order_value_minor,
    total_refunds_minor: 0,
    top_items: [...itemQty.entries()]
      .map(([name, quantity]) => ({ name, quantity, revenue_minor: itemRev.get(name) ?? 0 }))
      .sort((a, b) => b.revenue_minor - a.revenue_minor)
      .slice(0, 10),
    orders_by_status,
    revenue_by_day: [...byDay.entries()]
      .map(([date, v]) => ({ date, revenue_minor: v.revenue_minor }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    offline: true,
  };
}

async function localOrders(businessId: string): Promise<LocalOrderRow[]> {
  const { data } = await listLocalOrders(businessId, {}, 1, 500);
  return ((data as unknown as LocalOrderRow[]) ?? []);
}

export function useSellerAnalyticsQuery(period: "today" | "this_week" | "this_month" = "today", enabled = true) {
  const businessId = useBusinessId();
  const online = useIsEffectivelyOnline();
  return useQuery({
    queryKey: SELLER_ANALYTICS_KEYS.analytics(businessId ?? "", period),
    queryFn: async () => {
      if (!online) {
        try {
          return { data: aggregateLocal(await localOrders(businessId!), period, { forRevenueSummary: false }) };
        } catch {
          return { data: aggregateLocal([], period, { forRevenueSummary: false }) };
        }
      }
      try {
        const backendRes = await analyticsService.fetchSellerAnalytics(businessId! as string, period) as { data?: { period?: string; revenue_by_day?: unknown[] } };
        // Safety net: if backend doesn't filter by period (returns all days regardless), filter locally
        const backendData = backendRes.data;
        const byDay = backendData?.revenue_by_day as Array<{ date?: string }> | undefined;
        const shouldFilterLocally = 
          !byDay?.length ||
          (period === "today" && byDay.length > 1) ||
          (period === "this_week" && byDay.some(d => {
            const day = new Date(d.date ?? "");
            const now = new Date();
            const startOfWeek = new Date(now);
            startOfWeek.setDate(now.getDate() - now.getDay());
            return day < startOfWeek || day > now;
          }));
        if (shouldFilterLocally) {
          const localOrdersData = await localOrders(businessId!);
          return { data: aggregateLocal(localOrdersData, period, { forRevenueSummary: false }) };
        }
        return backendRes;
      } catch {
        return { data: aggregateLocal(await localOrders(businessId!), period, { forRevenueSummary: false }) };
      }
    },
    enabled: enabled && Boolean(businessId),
    staleTime: 30000,
    ...OFFLINE_FIRST,
  });
}

export function useRevenueSummaryQuery(period: "today" | "this_week" | "this_month" = "today", enabled = true) {
  const businessId = useBusinessId();
  const online = useIsEffectivelyOnline();
  return useQuery({
    queryKey: REVENUE_KEYS.summary(businessId ?? "", period),
    queryFn: async () => {
      if (!online) {
        try {
          return { data: aggregateLocal(await localOrders(businessId!), period, { forRevenueSummary: true }) };
        } catch {
          return { data: aggregateLocal([], period, { forRevenueSummary: true }) };
        }
      }
      try {
        const backendRes = await analyticsService.fetchRevenueSummary(businessId! as string, period) as { data?: { period?: string; by_day?: unknown[] } };
        // Safety net: if backend doesn't filter by period (returns all days regardless), filter locally
        const backendData = backendRes.data;
        const byDay = backendData?.by_day as Array<{ date?: string }> | undefined;
        const shouldFilterLocally = 
          !byDay?.length ||
          (period === "today" && byDay.length > 1) ||
          (period === "this_week" && byDay.some(d => {
            const day = new Date(d.date ?? "");
            const now = new Date();
            const startOfWeek = new Date(now);
            startOfWeek.setDate(now.getDate() - now.getDay());
            return day < startOfWeek || day > now;
          }));
        if (shouldFilterLocally) {
          const localOrdersData = await localOrders(businessId!);
          return { data: aggregateLocal(localOrdersData, period, { forRevenueSummary: true }) };
        }
        return backendRes;
      } catch {
        return { data: aggregateLocal(await localOrders(businessId!), period, { forRevenueSummary: true }) };
      }
    },
    enabled: enabled && Boolean(businessId),
    staleTime: 30000,
    ...OFFLINE_FIRST,
  });
}
