/**
 * Seller analytics hooks — single source for both apps.
 * Offline-first: local SQLite aggregates serve instantly; the network
 * refreshes silently when online.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { analyticsService } from "../adapters/services";
import { listLocalOrders } from "../domain/orders/service";
import { pullRemoteOrders } from "../sync/sync-jobs.service";
import { syncLogger } from "../utils/sync-logger";
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
  currency?: string;
  inserted_at: string;
  is_pos?: boolean;
  payment_mode?: string;
  pos_payment_method?: string;
  order_type?: string;
  user?: { id?: string; full_name?: string | null } | null;
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
  const byChannel = new Map<string, { revenue_minor: number; count: number }>();
  const byTeller = new Map<
    string,
    { name: string; revenue_minor: number; count: number }
  >();
  const byHour = new Map<string, { revenue_minor: number; count: number }>();
  const itemQty = new Map<string, number>();
  const itemRev = new Map<string, number>();

  for (const o of revenueOrders) {
    // `is_pos` is the only online/local discriminator — same as backend.
    const channel = o.is_pos ? "local" : "online";
    const ch = byChannel.get(channel) ?? { revenue_minor: 0, count: 0 };
    ch.revenue_minor += o.total_minor ?? 0;
    ch.count += 1;
    byChannel.set(channel, ch);

    // POS uses the tendered method; online orders cannot truthfully be
    // labelled card/MoMo from order data, so prepaid stays "online_prepaid".
    const method = o.is_pos
      ? (o.pos_payment_method ?? "cash")
      : o.payment_mode === "pay_on_delivery"
        ? "pay_on_delivery"
        : "online_prepaid";
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

    if (o.is_pos) {
      const key = o.user?.id ?? "unassigned";
      const teller = byTeller.get(key) ?? {
        name: o.user?.full_name ?? "Unassigned",
        revenue_minor: 0,
        count: 0,
      };
      teller.revenue_minor += o.total_minor ?? 0;
      teller.count += 1;
      byTeller.set(key, teller);
    }

    const hourDate = new Date(o.inserted_at ?? "");
    if (!Number.isNaN(hourDate.getTime())) {
      const hour = String(hourDate.getUTCHours());
      const h = byHour.get(hour) ?? { revenue_minor: 0, count: 0 };
      h.revenue_minor += o.total_minor ?? 0;
      h.count += 1;
      byHour.set(hour, h);
    }

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
  const by_channel = [...byChannel.entries()]
    .map(([channel, v]) => ({
      channel,
      ...v,
      percentage: pct(v.revenue_minor),
    }))
    .sort((a, b) => b.revenue_minor - a.revenue_minor);
  const by_payment_method = [...byMethod.entries()]
    .map(([method, v]) => ({
      method,
      ...v,
      percentage: pct(v.revenue_minor),
    }))
    .sort((a, b) => b.revenue_minor - a.revenue_minor);
  const by_order_type = [...byType.entries()]
    .map(([type, v]) => ({ type, ...v }))
    .sort(
      (a, b) =>
        b.revenue_minor - a.revenue_minor || a.type.localeCompare(b.type),
    );
  const by_teller = [...byTeller.entries()]
    .map(([user_id, v]) => ({
      user_id,
      name: v.name,
      revenue_minor: v.revenue_minor,
      count: v.count,
      average_order_value_minor: v.count
        ? Math.floor(v.revenue_minor / v.count)
        : 0,
    }))
    .sort((a, b) => b.revenue_minor - a.revenue_minor);
  const by_hour = [...byHour.entries()]
    .map(([hour, v]) => ({
      hour: Number(hour),
      revenue_minor: v.revenue_minor,
      count: v.count,
    }))
    .sort((a, b) => a.hour - b.hour);
  const currency = revenueOrders[0]?.currency ?? "GHS";

  if (opts.forRevenueSummary) {
    return {
      period,
      currency,
      total_revenue_minor,
      total_orders,
      average_order_value_minor,
      by_payment_method,
      by_order_type,
      by_day: [...byDay.entries()]
        .map(([date, v]) => ({ date, ...v }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      by_channel,
      by_teller,
      by_hour,
      offline: true,
    };
  }
  return {
    period,
    currency,
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
    by_channel,
    by_payment_method,
    by_order_type,
    by_teller,
    by_hour,
    offline: true,
  };
}

async function localOrders(businessId: string): Promise<LocalOrderRow[]> {
  const pageSize = 500;
  const first = await listLocalOrders(businessId, {}, 1, pageSize);
  const rows = [...((first.data as unknown as LocalOrderRow[]) ?? [])];
  const total = first.total ?? rows.length;
  for (let page = 2; rows.length < total; page += 1) {
    const next = await listLocalOrders(businessId, {}, page, pageSize);
    const batch = (next.data as unknown as LocalOrderRow[]) ?? [];
    if (batch.length === 0) break;
    rows.push(...batch);
  }
  return rows;
}

function hasCustomRange(period: AnalyticsPeriod, range?: AnalyticsRange) {
  return (
    period !== "custom" || Boolean(range?.date_from && range?.date_to)
  );
}

const ORDER_PULL_COOLDOWN_MS = 15_000;
const lastOrderPullAt = new Map<string, number>();

/**
 * Refresh the local order read model in the background. Analytics renders
 * from SQLite immediately; this pull is what makes a freshly opened screen
 * converge with the server without blocking the first paint.
 */
async function syncOrdersForAnalytics(
  businessId: string,
  queryClient: ReturnType<typeof useQueryClient>,
) {
  const now = Date.now();
  const last = lastOrderPullAt.get(businessId) ?? 0;
  if (now - last < ORDER_PULL_COOLDOWN_MS) return;
  lastOrderPullAt.set(businessId, now);

  try {
    await pullRemoteOrders(businessId);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: SELLER_ANALYTICS_KEYS.all }),
      queryClient.invalidateQueries({ queryKey: REVENUE_KEYS.all }),
    ]);
  } catch (error) {
    syncLogger.debug("Analytics", "background order sync failed", {
      businessId,
      err: String(error),
    });
  }
}

interface AnalyticsPayload {
  total_orders?: number;
  [key: string]: unknown;
}

interface AnalyticsResponse {
  data?: AnalyticsPayload;
  [key: string]: unknown;
}

/**
 * Keep local data when it knows about more orders than the server snapshot
 * (e.g. an offline order still in the outbox). Otherwise the server snapshot
 * wins because it may include older history the device has never pulled.
 */
function preferRemote(
  current: AnalyticsResponse | undefined,
  remote: AnalyticsResponse,
): AnalyticsResponse {
  const localOrders = current?.data?.total_orders ?? 0;
  const remoteOrders = remote.data?.total_orders ?? 0;
  return remoteOrders >= localOrders ? remote : (current ?? remote);
}

async function buildLocalAnalytics(
  businessId: string,
  period: AnalyticsPeriod,
  range?: AnalyticsRange,
): Promise<AnalyticsResponse> {
  try {
    return {
      data: aggregateLocal(
        await localOrders(businessId),
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

async function buildLocalRevenue(
  businessId: string,
  period: AnalyticsPeriod,
  range?: AnalyticsRange,
): Promise<AnalyticsResponse> {
  try {
    return {
      data: aggregateLocal(
        await localOrders(businessId),
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

export function useSellerAnalyticsQuery(
  period: AnalyticsPeriod = "today",
  enabled = true,
  range?: AnalyticsRange,
) {
  const businessId = useBusinessId();
  const online = useIsEffectivelyOnline();
  const queryClient = useQueryClient();
  const customReady = hasCustomRange(period, range);
  const queryKey = SELLER_ANALYTICS_KEYS.analytics(
    businessId ?? "",
    period,
    range,
  );
  const active = enabled && Boolean(businessId) && customReady;

  // Local-first: read SQLite on every query run. The network is a background
  // refresh only, so opening the screen never waits on the server.
  useEffect(() => {
    if (!active || !online || !businessId) return;
    void syncOrdersForAnalytics(businessId, queryClient);
  }, [active, online, businessId, queryClient]);

  return useQuery({
    queryKey,
    queryFn: async () => {
      const local = await buildLocalAnalytics(
        businessId!,
        period,
        range,
      );

      if (online && businessId) {
        // Do not await. Once the server snapshot arrives, merge it into the
        // cache only when it is at least as complete as the local model.
        void analyticsService
          .fetchSellerAnalytics(businessId, period, range)
          .then((remote) => {
            const remoteResponse = remote as AnalyticsResponse;
            const current =
              queryClient.getQueryData<AnalyticsResponse>(queryKey);
            queryClient.setQueryData(
              queryKey,
              preferRemote(current, remoteResponse),
            );
          })
          .catch((error) => {
            syncLogger.debug("Analytics", "background analytics refresh failed", {
              businessId,
              err: String(error),
            });
          });
      }

      return local;
    },
    enabled: active,
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
  const queryClient = useQueryClient();
  const customReady = hasCustomRange(period, range);
  const queryKey = REVENUE_KEYS.summary(businessId ?? "", period, range);
  const active = enabled && Boolean(businessId) && customReady;

  useEffect(() => {
    if (!active || !online || !businessId) return;
    void syncOrdersForAnalytics(businessId, queryClient);
  }, [active, online, businessId, queryClient]);

  return useQuery({
    queryKey,
    queryFn: async () => {
      const local = await buildLocalRevenue(businessId!, period, range);

      if (online && businessId) {
        void analyticsService
          .fetchRevenueSummary(businessId, period, range)
          .then((remote) => {
            const remoteResponse = remote as AnalyticsResponse;
            const current =
              queryClient.getQueryData<AnalyticsResponse>(queryKey);
            queryClient.setQueryData(
              queryKey,
              preferRemote(current, remoteResponse),
            );
          })
          .catch((error) => {
            syncLogger.debug(
              "Analytics",
              "background revenue refresh failed",
              { businessId, err: String(error) },
            );
          });
      }

      return local;
    },
    enabled: active,
    staleTime: 30000,
    ...OFFLINE_FIRST,
  });
}
