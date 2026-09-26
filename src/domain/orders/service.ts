/**
 * Local Orders Service — SQLite is real DB (like backend Orders).
 * Device-partitioned by UUID PK + DD-RRR-CCC per business.
 * is_pos orders are accepted at create; online payment requires online.
 */

import { openSyncDatabase } from "../../db/connection";
import { insertOrder, getOrderById, listOrders, updateOrderStatus, updateOrderPayment, getEntitySnapshotsByType } from "../../db/operations";
import { getDeviceNumber, ensureLease } from "../../sync/device-lease.service";
import { generateOrderNumberForBusiness } from "../../sync/order-number";
import { generateUUID } from "../../utils/uuid";
import { getConnectivityState } from "../../adapters/connectivity";
import { assertOnlineFor } from "../../sync/online-gates";
import { assertBusinessOpenForCreate } from "../../utils/business-hours";
import { canTransition } from "../../utils/order-transitions";
import { TRANSITION_ERROR_CODES, TransitionError } from "../../sync/transition-errors";
import { validateOrderCreateInput } from "../../validation/offline";
import { buildItemSnapshots, snapshotsToOrderLines } from "./snapshots";
import { drainOne, pullRemoteOrders } from "../../sync/sync-jobs.service";
import { getAuthToken } from "../../adapters/auth";
import { canBusinessSync } from "../../sync/sync-guard";
import { syncLogger } from "../../utils/sync-logger";
import { getItem } from "../../adapters/kv";
import type { SellerOrder } from "../../types/api/seller.api";
import type { POSOrderCreateRequest } from "../../types/pos.types";

let backfilled = new Set<string>();
async function ensureOrdersBackfilledFromSnapshots(businessId: string): Promise<void> {
  if (backfilled.has(businessId)) return;
  try {
    const db = await openSyncDatabase();
    const cnt = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(*) as c FROM orders WHERE business_id=?;`, businessId);
    if ((cnt?.c ?? 0) > 0) { backfilled.add(businessId); return; }
    const snaps = await getEntitySnapshotsByType<{ data: SellerOrder[] }>(db, "seller_orders", businessId);
    if (!snaps.length) { backfilled.add(businessId); return; }
    const seen = new Set<string>();
    for (const s of snaps) {
      const arr = (s.payload as { data?: SellerOrder[] })?.data ?? [];
      for (const o of arr as SellerOrder[]) {
        if (!o?.id || !o.order_number || seen.has(o.id)) continue;
        seen.add(o.id);
        try { await insertOrder(db, o as SellerOrder & { hlc?: string }); } catch {}
      }
    }
    if (seen.size > 0) {
      try { console.debug("[core] backfilled orders from seller_orders snapshots", { businessId, count: seen.size }); } catch {}
    }
    backfilled.add(businessId);
  } catch {}
}

function isEffectivelyOnline(): boolean {
  const s = getConnectivityState();
  // Health probe failure means backend unreachable — treat as offline for order gates too
  return s.isOnline && s.isCloudReachable !== "unreachable";
}
function isOnline(): boolean {
  return isEffectivelyOnline();
}

export async function createLocalOrder(businessId: string, input: POSOrderCreateRequest & { is_pos?: boolean; delivery_params?: Record<string, unknown> }): Promise<SellerOrder> {
  if (!businessId || !canBusinessSync(businessId)) {
    throw new Error("Cannot create order without active business/login");
  }
  const isPos = true; // POS terminal always is_pos
  // Online-required gates (single source: sync/online-gates). Cash needs no
  // connectivity; prepaid/mobile-money and delivery do.
  assertOnlineFor("order:create", input as unknown as Record<string, unknown>);
  // Offline validation mirror — backend Order.changeset rules, pre-commit.
  validateOrderCreateInput(input as unknown as Parameters<typeof validateOrderCreateInput>[0]);
  const method = (input.pos_payment_method as string) ?? "cash";
  // Operating-hours gate (fail-closed, offline-first): matches backend
  // validate_business_open. Throws BUSINESS_CLOSED / HOURS_NOT_SYNCED before
  // anything is written, so a doomed order never enters SQLite/sync_jobs.
  await assertBusinessOpenForCreate(businessId, new Date(), "pos");
  // DD lease required (backend lease, not local alloc) — keep leased DD even offline
  let dd = getDeviceNumber(businessId);
  if (!dd) {
    // Boot race: sync KV may not yet have hydrated from kv.json — try async before blocking
    try {
      const asyncDd = await getItem<string>(`teinc_device_number:${businessId}`);
      if (asyncDd && /^(0[1-9]|[1-9][0-9])$/.test(asyncDd)) dd = asyncDd;
    } catch {}
  }
  if (!dd) {
    const leased = await ensureLease(businessId);
    if (leased) dd = leased;
  }
  if (!dd) throw new Error("No device number leased (99 max) — connect online once to lease DD");

  const id = ((input as unknown as { id?: string }).id ?? (input as unknown as { command_id?: string }).command_id ?? generateUUID());
  const orderNumber = (input as unknown as { order_number?: string }).order_number?.toString() ?? generateOrderNumberForBusiness(businessId);
  const callout = parseInt(orderNumber.split("-")[2] ?? "0", 10) || 0;
  // Use client-provided timestamps for offline-first sync so records created
  // while offline retain their original creation time.
  const now = new Date().toISOString();
  const insertedAt = (input as unknown as { inserted_at?: string }).inserted_at || now;
  // Sale-time snapshots (canonical builder): names are embedded once and
  // never re-resolved from the menu cache — offline history is self-contained.
  const snapshots = buildItemSnapshots(
    ((input as unknown as { item_snapshots?: unknown }).item_snapshots as never) ??
      (input.items as never) ??
      [],
  );
  const items = snapshotsToOrderLines(snapshots, id);

  const totalMinor = (input as unknown as { total_minor?: number }).total_minor ?? 0;
  const subtotalMinor = (input as unknown as { subtotal_minor?: number }).subtotal_minor ?? totalMinor;
  const taxMinor = (input as unknown as { tax_minor?: number }).tax_minor ?? 0;
  const taxLines = (input as unknown as { tax_lines?: unknown[] }).tax_lines ?? [];
  const currencyCode = (input as unknown as { currency_code?: string }).currency_code ?? "GHS";

  const order: SellerOrder = {
    id,
    order_number: orderNumber,
    callout_number: callout,
    status: isPos ? "accepted" : "pending",
    order_type: (input.order_type as string) ?? "takeout",
    is_pos: isPos,
    customer_name: (input.customer_name as string) ?? null,
    customer_phone: (input.customer_phone as string) ?? null,
    pos_payment_method: method,
    paid_at: method === "cash" ? insertedAt : null,
    is_paid: method === "cash",
    payment: { is_paid: method === "cash", reference: null, amount_minor: totalMinor, currency: currencyCode, paid_at: method === "cash" ? insertedAt : null } as SellerOrder["payment"],
    payment_mode: method === "cash" ? "pos_cash" : "prepaid",
    total_minor: totalMinor,
    subtotal_minor: subtotalMinor,
    delivery_fee_minor: (input as unknown as { delivery_fee_minor?: number }).delivery_fee_minor ?? 0,
    tax_minor: taxMinor,
    tip_minor: null,
    discount_minor: 0,
    promo_code: null,
    tax_lines: taxLines as SellerOrder["tax_lines"],
    currency: currencyCode,
    currency_code: currencyCode,
    business_id: businessId,
    business: null,
    delivery_address: null,
    delivery_lat: null,
    delivery_lng: null,
    delivery_id: null,
    delivery_status: null,
    user: null,
    items: items as SellerOrder["items"],
    inserted_at: insertedAt,
  } as unknown as SellerOrder;

  const db = await openSyncDatabase();
  await insertOrder(db, order as unknown as SellerOrder & { hlc?: string });
  syncLogger.debug("DomainOrders", "createLocalOrder inserted", { businessId, id, orderNumber, isPos, connectivity: getConnectivityState(), hasToken: !!getAuthToken(), deviceNumber: dd });
  try {
    await db.runAsync(`INSERT OR IGNORE INTO sync_jobs (id, business_id, command_type, entity_id, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?);`, id, businessId, "order:create", id, JSON.stringify({ ...input, order_number: orderNumber, id }), now, now);
    syncLogger.debug("DomainOrders", "sync_jobs enqueued", { businessId, id, command_type: "order:create" });
  } catch (e) { syncLogger.debug("DomainOrders", "sync_jobs enqueue fail", { err: String(e) }); }
  syncLogger.debug("DomainOrders", "createLocalOrder triggering drainOne", { businessId, id });
  void drainOne(businessId, id).catch((e) => syncLogger.debug("DomainOrders", "drainOne after create caught", { err: String(e) }));
  return order;
}

export async function transitionLocalOrder(businessId: string, orderId: string, action: string): Promise<SellerOrder> {
  if (!businessId || !canBusinessSync(businessId)) {
    throw new TransitionError(TRANSITION_ERROR_CODES.NO_ACTIVE_BUSINESS, "Transition requires active business/login");
  }
  const db = await openSyncDatabase();
  const order = await getOrderById(db, businessId, orderId);
  if (!order) throw new TransitionError(TRANSITION_ERROR_CODES.ORDER_NOT_FOUND, "Order not found");
  // Delivery transitions require online (single source: sync/online-gates).
  if (action === "assign_rider") assertOnlineFor("order:assign_rider");
  else if (action === "confirm_handover") assertOnlineFor("order:confirm_handover");
  else if (order.order_type === "delivery") assertOnlineFor("order:create", { order_type: "delivery" });
  if (!canTransition(order, action as unknown as import("../../utils/order-transitions").OrderAction)) {
    throw new TransitionError(TRANSITION_ERROR_CODES.INVALID_TRANSITION, `Cannot ${action} from ${order.status}`);
  }
  const map: Record<string, string> = { accept: "accepted", reject: "cancelled", start_preparing: "preparing", mark_ready: "ready", complete_pickup: "delivered", cancel: "cancelled", assign_rider: "assigned", confirm_handover: "delivered", confirm_cash: order.status, pay: order.status };
  const toStatus = map[action] ?? order.status;
  if (action === "confirm_cash" || action === "pay") {
    await updateOrderPayment(db, businessId, orderId, { is_paid: true, paid_at: new Date().toISOString() });
  } else if (toStatus !== order.status) {
    await updateOrderStatus(db, businessId, orderId, toStatus);
  }
  try {
    const now = new Date().toISOString();
    const jobId = generateUUID();
    await db.runAsync(`INSERT OR IGNORE INTO sync_jobs (id, business_id, command_type, entity_id, payload, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?);`, jobId, businessId, `order:${action}`, orderId, JSON.stringify({ action, orderId }), now, now);
    syncLogger.debug("DomainOrders", "transition sync_jobs enqueued", { businessId, orderId, action, jobId });
    void drainOne(businessId, orderId).catch((e) => syncLogger.debug("DomainOrders", "drainOne after transition caught", { err: String(e) }));
  } catch (e) { syncLogger.debug("DomainOrders", "transition enqueue fail", { err: String(e) }); }
  const updated = await getOrderById(db, businessId, orderId);
  syncLogger.debug("DomainOrders", "transitionLocalOrder done", { businessId, orderId, action, from: order.status, to: updated?.status });
  return updated ?? order;
}

export async function listLocalOrders(businessId: string, filters?: { status?: string; q?: string; is_pos?: string; order_type?: string; date_from?: string; date_to?: string; is_paid?: string }, page = 1, pageSize = 20) {
  if (!businessId) {
    return { data: [], total: 0, page, pageSize, totalPages: 0 } as unknown as Awaited<ReturnType<typeof listOrders>>;
  }
  await ensureOrdersBackfilledFromSnapshots(businessId);
  const db = await openSyncDatabase();
  const res = await listOrders(db, businessId, filters, page, pageSize);
  if (res.total === 0) {
    // blank-screen: snapshot fallback already tried — if still empty and online, fetch from cloud now so listing populates without manual refresh
    if (isOnline() && canBusinessSync(businessId)) {
      try { await pullRemoteOrders(businessId); } catch {}
      const afterPull = await listOrders(db, businessId, filters, page, pageSize);
      if (afterPull.total > 0) return afterPull;
    }
    // filtered miss — still try backfill re-read
    if (!filters || Object.keys(filters).length === 0) {
      await ensureOrdersBackfilledFromSnapshots(businessId);
      if (backfilled.has(businessId)) {
        const retry = await listOrders(db, businessId, filters, page, pageSize);
        if (retry.total > 0) return retry;
      }
    }
  }
  return res;
}

export async function getLocalOrder(businessId: string, idOrNumber: string) {
  if (!businessId) return null;
  await ensureOrdersBackfilledFromSnapshots(businessId);
  const db = await openSyncDatabase();
  const found = await getOrderById(db, businessId, idOrNumber);
  if (found) return found;
  // fallback to snapshots for direct link before cloud pull
  try {
    const snaps = await getEntitySnapshotsByType<{ data: SellerOrder[] }>(db, "seller_orders", businessId);
    for (const s of snaps) {
      const hit = (s.payload as { data?: SellerOrder[] })?.data?.find((o) => o.id === idOrNumber || o.order_number === idOrNumber);
      if (hit) return hit;
    }
  } catch {}
  return null;
}
