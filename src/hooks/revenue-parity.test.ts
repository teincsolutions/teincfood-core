import { describe, it, expect } from "vitest";
import { computeDashboardMetrics } from "./dashboard.hooks";
import { aggregateLocal, filterByPeriod } from "./analytics.hooks";

const TODAY = new Date().toISOString().slice(0, 10);

function row(status: string, total_minor: number, extra: Record<string, unknown> = {}) {
  return {
    id: `o-${status}-${total_minor}`,
    order_number: `01-100-${total_minor}`,
    status,
    total_minor,
    inserted_at: `${TODAY}T10:00:00.000Z`,
    ...extra,
  };
}

describe("revenue parity with backend (cancelled excluded)", () => {
  const orders = [
    row("delivered", 1000),
    row("delivered", 2000),
    row("cancelled", 5000),
    row("ready", 1500),
    row("pending", 700),
  ];

  it("dashboard: revenue = delivered-only, orders = all, pending/active mirror backend", () => {
    const m = computeDashboardMetrics(orders as never, TODAY);
    expect(m.today_revenue_minor).toBe(3000);
    expect(m.today_orders).toBe(5);
    expect(m.pending_orders).toBe(1);
    expect(m.active_orders).toBe(1); // ready only
  });

  it("analytics: revenue/counts/breakdowns exclude cancelled", () => {
    const a = aggregateLocal(orders as never, "today", { forRevenueSummary: false }) as unknown as Record<string, unknown>;
    expect(a.total_revenue_minor).toBe(5200); // 1000+2000+1500+700
    expect(a.total_orders).toBe(4);
    expect(a.average_order_value_minor).toBe(Math.floor(5200 / 4));
    expect(a.orders_by_status).toEqual({ delivered: 2, cancelled: 1, pending: 1 });
    const byDay = a.revenue_by_day as Array<{ revenue_minor: number }>;
    expect(byDay.reduce((s, d) => s + d.revenue_minor, 0)).toBe(5200);
  });

  it("revenue summary: same exclusion", () => {
    const s = aggregateLocal(orders as never, "today", { forRevenueSummary: true }) as unknown as Record<string, unknown>;
    expect(s.total_revenue_minor).toBe(5200);
    expect(s.total_orders).toBe(4);
  });

  it("all-cancelled day = zero revenue, zero orders", () => {
    const only = [row("cancelled", 9000)];
    const m = computeDashboardMetrics(only as never, TODAY);
    expect(m.today_revenue_minor).toBe(0);
    expect(m.today_orders).toBe(1);
    const a = aggregateLocal(only as never, "today", { forRevenueSummary: false }) as unknown as Record<string, unknown>;
    expect(a.total_revenue_minor).toBe(0);
    expect(a.total_orders).toBe(0);
  });
});

describe("analytics dimensions match backend", () => {
  const orders = [
    row("delivered", 1000, {
      is_pos: true,
      order_type: "takeout",
      pos_payment_method: "cash",
      user: { id: "t1", full_name: "Teller One" },
      inserted_at: `${TODAY}T10:00:00.000Z`,
    }),
    row("delivered", 2000, {
      is_pos: true,
      order_type: "dine_in",
      pos_payment_method: "mobile_money",
      user: { id: "t2", full_name: "Teller Two" },
      inserted_at: `${TODAY}T11:00:00.000Z`,
    }),
    row("delivered", 3000, {
      is_pos: false,
      order_type: "takeout",
      payment_mode: "prepaid",
      user: { id: "buyer", full_name: "Buyer" },
      inserted_at: `${TODAY}T12:00:00.000Z`,
    }),
    row("delivered", 4000, {
      is_pos: false,
      order_type: "delivery",
      payment_mode: "pay_on_delivery",
      inserted_at: `${TODAY}T13:00:00.000Z`,
    }),
    row("cancelled", 9000, {
      is_pos: true,
      order_type: "takeout",
      pos_payment_method: "cash",
      user: { id: "t1", full_name: "Teller One" },
      inserted_at: `${TODAY}T10:00:00.000Z`,
    }),
  ];

  it("splits online/local by is_pos and only attributes POS orders to tellers", () => {
    const data = aggregateLocal(orders as never, "today", {
      forRevenueSummary: false,
    }) as unknown as Record<string, any>;

    expect(data.by_channel).toEqual([
      { channel: "online", revenue_minor: 7000, count: 2, percentage: 70 },
      { channel: "local", revenue_minor: 3000, count: 2, percentage: 30 },
    ]);
    expect(data.by_teller).toEqual([
      {
        user_id: "t2",
        name: "Teller Two",
        revenue_minor: 2000,
        count: 1,
        average_order_value_minor: 2000,
      },
      {
        user_id: "t1",
        name: "Teller One",
        revenue_minor: 1000,
        count: 1,
        average_order_value_minor: 1000,
      },
    ]);
  });

  it("labels online prepaid separately and keeps order-type/hour breakdowns", () => {
    const data = aggregateLocal(orders as never, "today", {
      forRevenueSummary: true,
    }) as unknown as Record<string, any>;

    expect(
      Object.fromEntries(
        data.by_payment_method.map((row: any) => [
          row.method,
          { revenue_minor: row.revenue_minor, count: row.count },
        ]),
      ),
    ).toEqual({
      cash: { revenue_minor: 1000, count: 1 },
      mobile_money: { revenue_minor: 2000, count: 1 },
      online_prepaid: { revenue_minor: 3000, count: 1 },
      pay_on_delivery: { revenue_minor: 4000, count: 1 },
    });
    expect(data.by_order_type).toEqual([
      { type: "delivery", revenue_minor: 4000, count: 1 },
      { type: "takeout", revenue_minor: 4000, count: 2 },
      { type: "dine_in", revenue_minor: 2000, count: 1 },
    ]);
    expect(data.by_hour).toEqual([
      { hour: 10, revenue_minor: 1000, count: 1 },
      { hour: 11, revenue_minor: 2000, count: 1 },
      { hour: 12, revenue_minor: 3000, count: 1 },
      { hour: 13, revenue_minor: 4000, count: 1 },
    ]);
  });
});

describe("offline analytics period boundaries", () => {
  // Sunday 1 Nov 2026. The backend week starts Monday 26 Oct.
  const now = new Date("2026-11-01T12:00:00.000Z");
  const rows = [
    { inserted_at: "2025-12-31T10:00:00.000Z" }, // previous year
    { inserted_at: "2026-01-15T10:00:00.000Z" }, // this year
    { inserted_at: "2026-10-23T10:00:00.000Z" }, // previous Friday
    { inserted_at: "2026-10-29T10:00:00.000Z" }, // Thursday
    { inserted_at: "2026-10-31T10:00:00.000Z" }, // Saturday
    { inserted_at: "2026-11-01T10:00:00.000Z" }, // Sunday / today
  ];

  it("this week starts on Monday, matching the backend", () => {
    expect(filterByPeriod(rows as never, "this_week", now)).toEqual([
      rows[3],
      rows[4],
      rows[5],
    ]);
  });

  it("this month starts on the 1st of the current month", () => {
    expect(filterByPeriod(rows as never, "this_month", now)).toEqual([
      rows[5],
    ]);
  });

  it("this year starts on 1 January and excludes last year", () => {
    expect(filterByPeriod(rows as never, "this_year", now)).toEqual([
      rows[1],
      rows[2],
      rows[3],
      rows[4],
      rows[5],
    ]);
  });

  it("custom range includes both boundary days", () => {
    expect(
      filterByPeriod(rows as never, "custom", now, {
        date_from: "2026-10-23",
        date_to: "2026-10-31",
      }),
    ).toEqual([rows[2], rows[3], rows[4]]);
  });

  it("custom range without both dates is empty", () => {
    expect(filterByPeriod(rows as never, "custom", now)).toEqual([]);
  });

  it("today only includes the current UTC day", () => {
    expect(filterByPeriod(rows as never, "today", now)).toEqual([rows[5]]);
  });
});
