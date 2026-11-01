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

export type AnalyticsPeriod =
  | "today"
  | "this_week"
  | "this_month"
  | "this_year"
  | "custom";

/** Inclusive UTC day bounds used by the custom range filter. */
export interface AnalyticsRange {
  date_from?: string;
  date_to?: string;
}

export const SELLER_ANALYTICS_KEYS = {
  all: ["seller-analytics"] as const,
  analytics: (
    businessId?: string,
    period?: AnalyticsPeriod,
    range?: AnalyticsRange,
  ) =>
    [
      ...SELLER_ANALYTICS_KEYS.all,
      businessId,
      period,
      range?.date_from ?? null,
      range?.date_to ?? null,
    ] as const,
};

export const REVENUE_KEYS = {
  all: ["revenue-summary"] as const,
  summary: (
    businessId?: string,
    period?: AnalyticsPeriod,
    range?: AnalyticsRange,
  ) =>
    [
      ...REVENUE_KEYS.all,
      businessId,
      period,
      range?.date_from ?? null,
      range?.date_to ?? null,
    ] as const,
};

function useBusinessId(): string | undefined {
  const id = useSyncExternalStore(
    subscribeBusiness,
    () => getActiveBusiness()?.id ?? null,
    () => null,
  );
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
 * Filter local rows to the same period boundaries as the backend
 * (`period_bounds/2`):
 *   - today      = current UTC day
 *   - this_week  = Monday 00:00 UTC → now (backend uses ISO weekday)
 *   - this_month = 1st of the current UTC month → now
 *   - this_year  = 1 January of the current UTC year → now
 *   - custom     = inclusive `date_from` → `date_to` (YYYY-MM-DD)
 *
 * Exported so the period boundaries can be regression-tested with a fixed
 * clock instead of depending on the day the suite runs.
 */
export function filterByPeriod(
  orders: LocalOrderRow[],
  period: AnalyticsPeriod,
  now: Date = new Date(),
  range?: AnalyticsRange,
): LocalOrderRow[] {
  const todayStr = now.toISOString().slice(0, 10);

  if (period === "today") {
    return orders.filter((o) => (o.inserted_at ?? "").slice(0, 10) === todayStr);
  }

  if (period === "custom") {
    const from = range?.date_from;
    const to = range?.date_to;
    if (!from || !to) return [];
    return orders.filter((o) => {
      const d = (o.inserted_at ?? "").slice(0, 10);
      return d >= from && d <= to;
    });
  }

  let startStr: string;
  if (period === "this_week") {
    // `getUTCDay()` is 0 for Sunday; shift so Monday is the first day.
    const todayUtc = new Date(`${todayStr}T00:00:00.000Z`);
    const daysSinceMonday = (todayUtc.getUTCDay() + 6) % 7;
    const startOfWeek = new Date(todayUtc);
    startOfWeek.setUTCDate(todayUtc.getUTCDate() - daysSinceMonday);
    startStr = startOfWeek.toISOString().slice(0, 10);
  } else if (period === "this_year") {
    startStr = `${todayStr.slice(0, 4)}-01-01`;
  } else {
    startStr = `${todayStr.slice(0, 7)}-01`;
  }

  return orders.filter((o) => {
    const d = (o.inserted_at ?? "").slice(0, 10);
    return d >= startStr && d <= todayStr;
  });
}

export function aggregateLocal(
  orders: LocalOrderRow[],
  period: AnalyticsPeriod,
  opts: AggregateOptions,
  range?: AnalyticsRange,
) {
  const filtered = filterByPeriod(orders, period, new Date(), range);
  // Backend parity (orders.ex get_business_analytics / get_revenue_summary):
  // revenue-eligible = all EXCEPT cancelled. Cancelled orders must never
  // inflate revenue, counts, breakdowns, or top items — online and offline.
  const revenueOrders = filtered.filter((o) => o.status !== "cancelled");
  const total_revenue_minor = revenueOrders.reduce(
    (s, o) => s + (o.total_minor ?? 0),
    0,
  );
  const total_orders = revenueOrders.length;
  // Backend uses div (truncation) — mirror, don't round.
  const average_order_value_minor = total_orders
    ? Math.floor(total_revenue_minor / total_orders)
    : 0;
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
  const pct = (v: number) =>
    total_revenue_minor > 0
      ? Math.round((v / total_revenue_minor) * 1000) / 10
      : 0;
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
        .map(([method, v]) => ({
          method,
          ...v,
          percentage: pct(v.revenue_minor),
        }))
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
      .map(([name, quantity]) => ({
        name,
        quantity,
        revenue_minor: itemRev.get(name) ?? 0,
      }))
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
  return (data as unknown as LocalOrderRow[]) ?? [];
}

function hasCustomRange(period: AnalyticsPeriod, range?: AnalyticsRange) {
  return (
    period !== "custom" || Boolean(range?.date_from && range?.date_to)
  );
}

export function useSellerAnalyticsQuery(
  period: AnalyticsPeriod = "today",
  enabled = true,
  range?: AnalyticsRange,
) {
  const businessId = useBusinessId();
  const online = useIsEffectivelyOnline();
  const customReady = hasCustomRange(period, range);
  return useQuery({
    queryKey: SELLER_ANALYTICS_KEYS.analytics(
      businessId ?? "",
      period,
      range,
    ),
    queryFn: async () => {
      if (!online) {
        try {
          return {
            data: aggregateLocal(
              await localOrders(businessId!),
              period,
              { forRevenueSummary: false },
              range,
            ),
          };
        } catch {
          return {
            data: aggregateLocal(
              [],
              period,
              { forRevenueSummary: false },
              range,
            ),
          };
        }
      }
      try {
        // The backend applies the period filter itself. An empty
        // `revenue_by_day` is a valid result (e.g. no orders today) and must
        // not be replaced with local rows — doing that hid real backend data.
        return await analyticsService.fetchSellerAnalytics(
          businessId! as string,
          period,
          range,
        );
      } catch {
        return {
          data: aggregateLocal(
            await localOrders(businessId!),
            period,
            { forRevenueSummary: false },
            range,
          ),
        };
      }
    },
    enabled: enabled && Boolean(businessId) && customReady,
    staleTime: 30000,
    ...OFFLINE_FIRST,
  });
}

export function useRevenueSummaryQuery(
  period: AnalyticsPeriod = "today",
  enabled = true,
  range?: AnalyticsRange,
) {
  const businessId = useBusinessId();
  const online = useIsEffectivelyOnline();
  const customReady = hasCustomRange(period, range);
  return useQuery({
    queryKey: REVENUE_KEYS.summary(businessId ?? "", period, range),
    queryFn: async () => {
      if (!online) {
        try {
          return {
            data: aggregateLocal(
              await localOrders(businessId!),
              period,
              { forRevenueSummary: true },
              range,
            ),
          };
        } catch {
          return {
            data: aggregateLocal(
              [],
              period,
              { forRevenueSummary: true },
              range,
            ),
          };
        }
      }
      try {
        // Same contract as analytics: trust the backend period filter and
        // only fall back to SQLite when the request itself fails.
        return await analyticsService.fetchRevenueSummary(
          businessId! as string,
          period,
          range,
        );
      } catch {
        return {
          data: aggregateLocal(
            await localOrders(businessId!),
            period,
            { forRevenueSummary: true },
            range,
          ),
        };
      }
    },
    enabled: enabled && Boolean(businessId) && customReady,
    staleTime: 30000,
    ...OFFLINE_FIRST,
  });
}
