/**
 * Offline order list helpers — shared filtering + pagination for
 * usePOSOrdersQuery / useSellerOrdersQuery snapshot fallbacks.
 */

import type { SellerOrder } from "../types/api/seller.api";
import { matchesCustomerSearch } from "./customer-display";

export function filterOrdersOffline(
  orders: SellerOrder[],
  filters?: { status?: string; order_type?: string; is_pos?: string; q?: string; search?: string; date_from?: string; date_to?: string },
): SellerOrder[] {
  let filtered = orders;
  const statusSet = filters?.status ? new Set(filters.status.split(",").map((s) => s.trim())) : null;
  if (statusSet) filtered = filtered.filter((o) => statusSet.has(o.status));
  if (filters?.order_type) filtered = filtered.filter((o) => (o.order_type ?? "pos") === filters.order_type);
  if (filters?.is_pos !== undefined) {
    const wantPos = filters.is_pos === "true" || filters.is_pos === "1";
    filtered = filtered.filter((o) => !!o.is_pos === wantPos);
  }
  const q = (filters?.q ?? filters?.search ?? "").toLowerCase();
  if (q) {
    filtered = filtered.filter(
      (o) =>
        o.order_number.toLowerCase().includes(q) ||
        matchesCustomerSearch(o as unknown as Parameters<typeof matchesCustomerSearch>[0], q),
    );
  }
  if (filters?.date_from) {
    const from = filters.date_from.slice(0, 10);
    filtered = filtered.filter((o) => (o.inserted_at ?? "").slice(0, 10) >= from);
  }
  if (filters?.date_to) {
    const to = filters.date_to.slice(0, 10);
    filtered = filtered.filter((o) => (o.inserted_at ?? "").slice(0, 10) <= to);
  }
  return filtered;
}

export function filterSellerOrdersOffline(
  orders: SellerOrder[],
  filters?: { status?: string; q?: string },
): SellerOrder[] {
  let filtered = orders;
  if (filters?.status) {
    const set = new Set(filters.status.split(",").map((s) => s.trim()));
    filtered = filtered.filter((o) => set.has(o.status));
  }
  if (filters?.q) {
    const q = filters.q.toLowerCase();
    filtered = filtered.filter(
      (o) => o.order_number.toLowerCase().includes(q) || matchesCustomerSearch(o as unknown as Parameters<typeof matchesCustomerSearch>[0], q),
    );
  }
  return filtered;
}

export function paginateOffline<T>(orders: T[], page: number, pageSize = 20): { data: T[]; pagination: { page: number; page_size: number; total_pages: number; total_count: number } } {
  const start = (page - 1) * pageSize;
  const slice = orders.slice(start, start + pageSize);
  const totalPages = Math.max(1, Math.ceil(orders.length / pageSize));
  return { data: slice, pagination: { page, page_size: pageSize, total_pages: totalPages, total_count: orders.length } };
}
