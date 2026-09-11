/**
 * Sync Jobs FIFO — near real-time drain after local commit.
 * Tries PHX business:{id} push first, then REST, queues on fail.
 * Core-only, single in_flight per business, coalesced via isOnline gate.
 */

import { openSyncDatabase } from "../db/connection";
import { insertOrder } from "../db/operations";
import { getConnectivityState, subscribeConnectivity } from "../adapters/connectivity";
import { getAuthToken, getRefreshToken, setAuthTokens, clearAuth, subscribeAuth } from "../adapters/auth";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { getHttpClient } from "../adapters/http";
import { phoenixSocket } from "../realtime/phoenix-socket";
import { syncLogger } from "../utils/sync-logger";
import { BackoffTracker } from "./backoff";
import { generateOrderNumber } from "./order-number";
import { orderSnapshotsService } from "./order-snapshots.service";

const inflight = new Map<string, Promise<void>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const backoffTracker = new BackoffTracker();

function isOnline(): boolean {
  const s = getConnectivityState();
  return s.isOnline && s.isCloudReachable !== "unreachable";
}
function isOnlineForRest(): boolean {
  // Health probe failure = device offline per spec — don't hammer REST with 5xx/network when backend unreachable
  const s = getConnectivityState();
  return s.isOnline && s.isCloudReachable !== "unreachable";
}
function isOnlineForPhx(): boolean {
  const s = getConnectivityState();
  return s.isOnline && s.isCloudReachable === "reachable";
}

function scheduleRetry(businessId: string): void {
  if (retryTimers.has(businessId)) return;
  // Shared backoff curve: 2s doubling to a 5min cap with jitter. Attempts
  // reset on any success (clearRetry) so long outages go quiet instead of
  // hammering a down backend every 30s.
  const delay = backoffTracker.next(businessId);
  syncLogger.debug("SyncJobs", "scheduleRetry backoff", { businessId, delay });
  const t = setTimeout(() => {
    retryTimers.delete(businessId);
    if (isOnlineForRest() && getAuthToken() && getActiveBusiness()?.id === businessId) {
      syncLogger.debug("SyncJobs", "retry timer fired → drainPending", { businessId });
      void drainPending(businessId);
    }
  }, delay);
  retryTimers.set(businessId, t);
}
function clearRetry(businessId: string): void {
  const t = retryTimers.get(businessId);
  if (t) { clearTimeout(t); retryTimers.delete(businessId); }
  backoffTracker.reset(businessId);
}

async function tryPhxPush(businessId: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const socket: unknown = (phoenixSocket as unknown as { getChannel?: (topic: string) => { push: (event: string, p: unknown, timeout: number) => { receive: (status: string, cb: (r: unknown) => void) => unknown } } }).getChannel?.(`business:${businessId}`);
    if (!socket || !(socket as { push?: unknown }).push) return false;
    const chan = (phoenixSocket as unknown as { getChannel: (t: string) => { push: (e: string, p: unknown, t: number) => { receive: (s: string, cb: (r: unknown) => void) => { receive: (s: string, cb: (r: unknown) => void) => unknown } } } }).getChannel(`business:${businessId}`);
    return await new Promise<boolean>((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 2500);
      try {
        const push = chan.push("order:sync", payload, 2500);
        push.receive("ok", () => { if (!done) { done = true; clearTimeout(timer); resolve(true); } });
        push.receive("error", () => { if (!done) { done = true; clearTimeout(timer); resolve(false); } });
        push.receive("timeout", () => { if (!done) { done = true; clearTimeout(timer); resolve(false); } });
      } catch { if (!done) { done = true; clearTimeout(timer); resolve(false); } }
    });
  } catch { return false; }
}

async function tryRest(businessId: string, payload: Record<string, unknown>, commandType: string): Promise<{ ok: boolean; status?: number; code?: string; message?: string }> {
  try {
    const http = getHttpClient();
    if (!http) return { ok: false };
    // POS order create → business-scoped POS endpoint (backend: POSController.create_order expects id/local_order_number + items + order_type)
    if (commandType === "order:create") {
      const body: Record<string, unknown> = {
        id: payload.id,
        command_id: payload.id,
        local_order_number: payload.order_number ?? payload.local_order_number,
        order_number: payload.order_number ?? payload.local_order_number,
        items: payload.items,
        order_type: payload.order_type ?? "takeout",
        pos_payment_method: payload.pos_payment_method ?? "cash",
        customer_name: payload.customer_name,
        customer_phone: payload.customer_phone,
        notes: payload.notes,
      };
      // strip undefined to avoid backend validation noise
      Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
      await http.post(`/businesses/${businessId}/pos/orders`, body);
      return { ok: true };
    }
    // transitions → /orders/:id/* (OrderController)
    const orderId = (payload.orderId ?? payload.order_id ?? payload.entity_id ?? payload.id) as string | undefined;
    if (!orderId) return { ok: false, message: "missing orderId" };
    const map: Record<string, string> = {
      "order:accept": `/orders/${orderId}/accept`,
      "order:reject": `/orders/${orderId}/reject`,
      "order:start_preparing": `/orders/${orderId}/start-preparing`,
      "order:mark_ready": `/orders/${orderId}/ready-for-delivery`,
      "order:complete_pickup": `/orders/${orderId}/complete-pickup`,
      "order:cancel": `/orders/${orderId}/cancel`,
      "order:confirm_cash": `/orders/${orderId}/confirm-cash-payment`,
      "order:pay": `/orders/${orderId}/confirm-cash-payment`,
      "order:assign_rider": `/orders/${orderId}/assign`, // fallback, actual via deliveries/assign
      "order:confirm_handover": `/deliveries/${orderId}/confirm-handover`,
    };
    const path = map[commandType] ?? (commandType.startsWith("order:") ? `/orders/${orderId}/${commandType.replace("order:", "")}` : null);
    if (!path) return { ok: false, message: `unknown command ${commandType}` };
    await http.post(path, {});
    return { ok: true };
  } catch (e) {
    const err = e as {
      status?: number;
      code?: string;
      message?: string;
      response?: { status?: number; data?: { error?: { code?: string; message?: string } } };
    };
    const status = err.status ?? (err.response as { status?: number } | undefined)?.status;
    const bodyCode = (err.response as { data?: { error?: { code?: string } } } | undefined)?.data?.error?.code;
    const bodyMsg = (err.response as { data?: { error?: { message?: string } } } | undefined)?.data?.error?.message;
    return {
      ok: false,
      status,
      code: bodyCode ?? (err as unknown as { code?: string }).code,
      message: bodyMsg ?? err.message,
    };
  }
}

export async function drainOne(businessId: string, entityId: string): Promise<void> {
  const onlineForRest = isOnlineForRest();
  const onlineForPhx = isOnlineForPhx();
  const token = getAuthToken();
  const state = getConnectivityState();
  syncLogger.debug("SyncJobs", "drainOne entry", { businessId, entityId, isOnlineForRest: onlineForRest, isOnlineForPhx: onlineForPhx, isCloudReachable: state.isCloudReachable, hasToken: !!token, inflight: inflight.has(`${businessId}:${entityId}`) });
  if (!onlineForRest || !token) {
    syncLogger.debug("SyncJobs", "drainOne early-return gate", { businessId, entityId, onlineForRest, hasToken: !!token, connectivity: state });
    return;
  }
  const key = `${businessId}:${entityId}`;
  // Join an in-flight drain instead of skipping: concurrent drains (e.g. the
  // fire-and-forget drainOne after a write racing an awaited drainPending)
  // must converge on the same outcome, otherwise callers observe "drained"
  // while the POST is still flying.
  const ongoing = inflight.get(key);
  if (ongoing) {
    syncLogger.debug("SyncJobs", "drainOne joining inflight", { key });
    try { await ongoing; } catch {}
    return;
  }
  let resolveInflight!: () => void;
  inflight.set(key, new Promise<void>((r) => { resolveInflight = r; }));
  try {
    const db = await openSyncDatabase();
    const row = await db.getFirstAsync<{ id: string; business_id: string; command_type: string; payload: string }>(`SELECT * FROM sync_jobs WHERE business_id = ? AND entity_id = ? AND status='pending' ORDER BY created_at LIMIT 1;`, businessId, entityId);
    syncLogger.debug("SyncJobs", "drainOne fetched row", { businessId, entityId, found: !!row, command_type: row?.command_type });
    if (!row) {
      syncLogger.debug("SyncJobs", "drainOne no pending row", { businessId, entityId });
      return;
    }
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    // 1) PHX first (only when cloud reachable)
    let phxOk = false;
    if (isOnlineForPhx()) {
      syncLogger.debug("SyncJobs", "tryPhxPush start", { businessId, entityId, command_type: row.command_type });
      phxOk = await tryPhxPush(businessId, { ...payload, id: row.id, command_type: row.command_type, entity_id: row.id });
      syncLogger.debug("SyncJobs", "tryPhxPush result", { businessId, entityId, phxOk });
      if (phxOk) {
        await db.runAsync(`UPDATE sync_jobs SET status='completed', updated_at=? WHERE id=?;`, new Date().toISOString(), row.id);
        syncLogger.info("SyncJobs", "Drained via PHX", { businessId, entityId });
        clearRetry(businessId);
        try {
          const next = await db.getFirstAsync<{ id: string }>(`SELECT id FROM sync_jobs WHERE business_id=? AND entity_id=? AND status='pending' ORDER BY created_at LIMIT 1;`, businessId, entityId);
          if (next) setTimeout(() => void drainOne(businessId, entityId), 50);
        } catch {}
        return;
      }
    } else {
      syncLogger.debug("SyncJobs", "skip PHX, not reachable", { businessId, entityId, isCloudReachable: getConnectivityState().isCloudReachable });
    }
    // 2) REST fallback — use real backend routes (POSController + OrderController), not /orders/sync
    syncLogger.debug("SyncJobs", "tryRest start", { businessId, entityId, command_type: row.command_type, payloadKeys: Object.keys(payload) });
    const rest = await tryRest(businessId, { ...payload, id: row.id }, row.command_type);
    syncLogger.debug("SyncJobs", "tryRest result", { businessId, entityId, ok: rest.ok, status: rest.status, code: rest.code, message: rest.message });
    if (rest.ok) {
      await db.runAsync(`UPDATE sync_jobs SET status='completed', updated_at=? WHERE id=?;`, new Date().toISOString(), row.id);
      syncLogger.info("SyncJobs", "Drained via REST", { businessId, entityId, command_type: row.command_type });
      clearRetry(businessId);
      // Immediately drain next pending for same entity (FIFO chain: create -> prepare -> ready -> pickup should sync in order without waiting for timer)
      try {
        const next = await db.getFirstAsync<{ id: string }>(`SELECT id FROM sync_jobs WHERE business_id=? AND entity_id=? AND status='pending' ORDER BY created_at LIMIT 1;`, businessId, entityId);
        if (next) {
          syncLogger.debug("SyncJobs", "chaining next job for same entity", { businessId, entityId });
          // fire next without inflight block — we already cleared inflight for this key, so recurse
          setTimeout(() => void drainOne(businessId, entityId), 50);
        }
      } catch {}
      return;
    }
    // 3) Handle 409 RRR regen same UUID (POS create only)
    syncLogger.debug("SyncJobs", "check 409", { businessId, entityId, status: rest.status, code: rest.code });
    const is409 = rest.status === 409 && (String(rest.code ?? "").includes("ORDER_NUMBER_TAKEN") || String(rest.message ?? "").includes("ORDER_NUMBER_TAKEN"));
    if (is409) {
      const on = (payload.order_number ?? payload.local_order_number) as string | undefined;
      const parsed = on ? String(on).match(/^([0-9]{2})-([0-9]{3})-([0-9]{3})$/) : null;
      if (parsed) {
        const newOn = generateOrderNumber(parsed[1], businessId).orderNumber;
        const newPayload = { ...payload, order_number: newOn, local_order_number: newOn };
        await db.runAsync(`UPDATE sync_jobs SET payload=?, updated_at=? WHERE id=?;`, JSON.stringify(newPayload), new Date().toISOString(), row.id);
        await db.runAsync(`UPDATE orders SET order_number=?, hlc=? WHERE business_id=? AND id=?;`, newOn, new Date().toISOString(), businessId, row.id);
        syncLogger.info("SyncJobs", "Regenerated RRR after 409", { businessId, newOn });
        scheduleRetry(businessId);
      }
      return;
    }
    if (rest.status === 401) {
      try {
        const refreshToken = getRefreshToken();
        if (refreshToken) {
          const http = getHttpClient();
          if (http) {
            const res = await http.post<{ access_token: string; refresh_token: string }>(`/auth/refresh`, { refresh_token: refreshToken });
            const data = (res.data as unknown as { data?: { access_token: string; refresh_token: string }; access_token?: string; refresh_token?: string });
            const at = (data as { data?: { access_token?: string } })?.data?.access_token ?? (data as { access_token?: string }).access_token;
            const rt = (data as { data?: { refresh_token?: string } })?.data?.refresh_token ?? (data as { refresh_token?: string }).refresh_token;
            if (at) {
              setAuthTokens(at, rt ?? refreshToken);
              const retry = await tryRest(businessId, { ...payload, id: row.id }, row.command_type);
              if (retry.ok) {
                await db.runAsync(`UPDATE sync_jobs SET status='completed', updated_at=? WHERE id=?;`, new Date().toISOString(), row.id);
                syncLogger.info("SyncJobs", "Drained via REST after refresh", { businessId, entityId });
                return;
              }
              if (retry.status === 401) {
                clearAuth();
                syncLogger.warn("SyncJobs", "Refresh expired → logout", { businessId });
                return;
              }
            } else {
              clearAuth();
            }
          }
        } else {
          syncLogger.debug("SyncJobs", "401 no refresh token — deferred", { businessId });
        }
      } catch {
        try { clearAuth(); } catch {}
      }
      syncLogger.debug("SyncJobs", "401 deferred until login", { businessId });
      return;
    }
    // Permanent 4xx (except 401/404/408/409/429) — don't retry infinitely; mark failed to stop sync spinner loop.
    // 404 is retryable (order not yet created on backend due to FIFO race), 409 is handled above for RRR regen.
    if (rest.status && rest.status >= 400 && rest.status < 500 && rest.status !== 401 && rest.status !== 404 && rest.status !== 408 && rest.status !== 409 && rest.status !== 429) {
      syncLogger.warn("SyncJobs", "Permanent 4xx — marking job failed to stop retry loop", { businessId, entityId, status: rest.status, code: rest.code, message: rest.message });
      try {
        await db.runAsync(`UPDATE sync_jobs SET status='failed', last_error=?, updated_at=? WHERE id=?;`, `${rest.status} ${rest.code ?? ""} ${rest.message ?? ""}`.trim(), new Date().toISOString(), row.id);
      } catch {}
      clearRetry(businessId);
      return;
    }
    // Keep pending for retry (5xx / network) — auto retry with backoff
    syncLogger.debug("SyncJobs", "drainOne kept pending for retry", { businessId, entityId, status: rest.status, code: rest.code });
    try {
      await db.runAsync(`UPDATE sync_jobs SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?;`, `${rest.status ?? "network"} ${rest.code ?? ""} ${rest.message ?? ""}`.trim(), new Date().toISOString(), row.id);
    } catch {}
    scheduleRetry(businessId);
  } finally {
    inflight.delete(key);
    try { resolveInflight(); } catch {}
    syncLogger.debug("SyncJobs", "drainOne exit", { businessId, entityId });
  }
}

export async function pullRemoteOrders(businessId: string): Promise<void> {
  const onlineForRest = isOnlineForRest();
  const hasToken = !!getAuthToken();
  syncLogger.debug("SyncJobs", "pullRemoteOrders entry", { businessId, onlineForRest, hasToken });
  if (!onlineForRest || !hasToken) {
    syncLogger.debug("SyncJobs", "pullRemoteOrders early-return gate", { businessId, onlineForRest, hasToken, connectivity: getConnectivityState() });
    return;
  }
  try {
    const http = getHttpClient();
    if (!http) {
      syncLogger.debug("SyncJobs", "pullRemoteOrders no http client", { businessId });
      return;
    }
    // Gradual recent-first pull for single business — page 1 immediate, then background older pages (max 5 pages = 100 recent)
    let page = 1;
    let totalPages = 1;
    do {
      syncLogger.debug("SyncJobs", "pullRemoteOrders GET start", { businessId, page });
      const res = await http.get<{ data: unknown[]; pagination: { total_pages: number; total_count?: number } }>(
        `/businesses/${businessId}/orders`,
        { params: { page, page_size: 20 } } as unknown as Record<string, unknown>,
      );
      const payload = res.data as unknown as { data?: unknown[]; pagination?: { total_pages: number } };
      const data = payload?.data ?? (res as unknown as { data: unknown[] }).data ?? [];
      const tp = payload?.pagination?.total_pages ?? 1;
      if (page === 1) totalPages = tp;
      syncLogger.debug("SyncJobs", "pullRemoteOrders GET result", { businessId, page, totalPages, dataLen: (data as unknown[]).length });
      if ((data as unknown[]).length) {
        const db = await openSyncDatabase();
        for (const o of data as unknown as import("../types/api/seller.api").SellerOrder[]) {
          try { await insertOrder(db, o as unknown as import("../types/api/seller.api").SellerOrder & { hlc?: string }); } catch (e) { syncLogger.debug("SyncJobs", "pullRemoteOrders insertOrder fail", { err: String(e) }); }
        }
        // persist page 1 to snapshot for offline fallback
        if (page === 1) {
          try { await orderSnapshotsService.persistSellerOrders(businessId, "list-main", data as unknown as import("../types/api/seller.api").SellerOrder[]); } catch {}
        }
      }
      page++;
      if (page <= totalPages && page <= 5) await new Promise((r) => setTimeout(r, 150));
    } while (page <= totalPages && page <= 5);
  } catch (e) {
    syncLogger.debug("SyncJobs", "pullRemoteOrders error", { businessId, err: String(e) });
  }
  // Also pull recent deliveries (single page recent) for single business
  try {
    const http = getHttpClient();
    if (http) {
      const r2 = await http.get<{ data: unknown[] }>(`/businesses/${businessId}/deliveries`, { params: { page: 1, page_size: 20 } } as unknown as Record<string, unknown>);
      const d = (r2.data as unknown as { data?: unknown[] })?.data ?? [];
      syncLogger.debug("SyncJobs", "pullRemoteDeliveries result", { businessId, dataLen: (d as unknown[]).length });
    }
  } catch (e) { syncLogger.debug("SyncJobs", "pullRemoteDeliveries error", { err: String(e) }); }
}

export async function drainPending(businessId: string): Promise<void> {
  const onlineForRest = isOnlineForRest();
  const hasToken = !!getAuthToken();
  syncLogger.debug("SyncJobs", "drainPending entry", { businessId, onlineForRest, hasToken, connectivity: getConnectivityState() });
  if (!onlineForRest || !hasToken) {
    syncLogger.debug("SyncJobs", "drainPending early-return gate", { businessId, onlineForRest, hasToken });
    return;
  }
  const db = await openSyncDatabase();
  const rows = await db.getAllAsync<{ entity_id: string }>(`SELECT entity_id FROM sync_jobs WHERE business_id=? AND status='pending' ORDER BY created_at LIMIT 20;`, businessId);
  syncLogger.debug("SyncJobs", "drainPending found rows", { businessId, count: rows.length, rows });
  for (const r of rows) {
    await drainOne(businessId, r.entity_id);
    await new Promise((res) => setTimeout(res, 100));
  }
  if (rows.length === 0) clearRetry(businessId);
  await pullRemoteOrders(businessId);
  syncLogger.debug("SyncJobs", "drainPending exit", { businessId });
  // if still pending, ensure backoff retry is scheduled
  try {
    const still = await db.getAllAsync<{ entity_id: string }>(`SELECT entity_id FROM sync_jobs WHERE business_id=? AND status='pending' LIMIT 1;`, businessId);
    if (still.length > 0) scheduleRetry(businessId);
    else clearRetry(businessId);
  } catch {}
}

let drainSetup = false;
export function setupSyncJobsDrain(): void {
  if (drainSetup) {
    syncLogger.debug("SyncJobs", "setupSyncJobsDrain already setup, skip");
    return;
  }
  drainSetup = true;
  syncLogger.debug("SyncJobs", "setupSyncJobsDrain init", { hasBusiness: !!getActiveBusiness()?.id, connectivity: getConnectivityState(), hasToken: !!getAuthToken() });
  try {
    subscribeConnectivity(() => {
      const b = getActiveBusiness()?.id;
      syncLogger.debug("SyncJobs", "subscribeConnectivity trigger", { businessId: b, connectivity: getConnectivityState(), hasToken: !!getAuthToken() });
      if (b && isOnlineForRest() && getAuthToken()) void drainPending(b);
    });
    subscribeBusiness(() => {
      const bid = getActiveBusiness()?.id;
      syncLogger.debug("SyncJobs", "subscribeBusiness trigger", { businessId: bid, hasToken: !!getAuthToken(), connectivity: getConnectivityState() });
      if (bid && isOnlineForRest() && getAuthToken()) void drainPending(bid);
    });
    subscribeAuth(() => {
      const b = getActiveBusiness()?.id;
      syncLogger.debug("SyncJobs", "subscribeAuth trigger", { businessId: b, hasToken: !!getAuthToken(), connectivity: getConnectivityState() });
      if (b && isOnlineForRest() && getAuthToken()) void drainPending(b);
    });
    const b0 = getActiveBusiness()?.id;
    syncLogger.debug("SyncJobs", "setupSyncJobsDrain initial check", { b0, isOnlineForRest: isOnlineForRest(), hasToken: !!getAuthToken() });
    if (b0 && isOnlineForRest() && getAuthToken()) void drainPending(b0);
  } catch (e) {
    syncLogger.debug("SyncJobs", "setupSyncJobsDrain error", { err: String(e) });
  }
}

// Debug helper for DiagnosticsScreen — read pending sync_jobs count
export async function getSyncJobsPendingCount(businessId: string): Promise<number> {
  try {
    const db = await openSyncDatabase();
    const rows = await db.getAllAsync<{ entity_id: string }>(`SELECT entity_id FROM sync_jobs WHERE business_id=? AND status='pending' ORDER BY created_at`, businessId);
    return rows.length;
  } catch { return 0; }
}
export async function debugDumpSyncJobs(businessId: string): Promise<Array<{ id: string; command_type: string; status: string; created_at: string; attempts: number; last_error: string | null }>> {
  try {
    const db = await openSyncDatabase();
    const rows = await db.getAllAsync<{ id: string; command_type: string; status: string; created_at: string; attempts: number; last_error: string | null }>(`SELECT id, command_type, status, created_at, attempts, last_error FROM sync_jobs WHERE business_id=? ORDER BY created_at`, businessId);
    return rows;
  } catch { return []; }
}
