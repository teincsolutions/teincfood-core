/**
 * Device lease service: DD 01-99 per business.
 * Backend authority: POST /businesses/:id/devices/lease
 * KV persists device_number per businessId.
 */

import { getItemSync as getSync, setItemSync as setSync, removeItemSync, getItem } from "../adapters/kv";
import { getHttpClient } from "../adapters/http";
import { syncLogger } from "../utils/sync-logger";
import { getAppInstanceIdAsync } from "../adapters/devices";
import { getConnectivityState } from "../adapters/connectivity";

const LEASE_KEY = (businessId: string) => `teinc_device_number:${businessId}`;
const LEASE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// DD 01 is reserved for online orders created by the buyer app. POS terminals
// lease 02-99 only, so local order numbers can never collide with online ones.
function isPosDeviceNumber(value: unknown): value is string {
  return typeof value === "string" && /^(0[2-9]|[1-9][0-9])$/.test(value);
}

interface LeaseResponse {
  device_number: string;
  device_uuid: string;
}

/**
 * Why the last device-lease attempt failed. Surfaced by startup readiness so a
 * plan/terminal limit is not reported as "offline data incomplete".
 */
export interface DeviceLeaseFailure {
  code:
    | "TERMINAL_LIMIT_REACHED"
    | "DEVICE_LIMIT_REACHED"
    | "AUTH_REQUIRED"
    | "OFFLINE"
    | "LEASE_FAILED";
  message: string;
  status?: number;
  limit?: number;
  current?: number;
}

const leaseFailures = new Map<string, DeviceLeaseFailure>();

export function getLastLeaseFailure(businessId: string): DeviceLeaseFailure | null {
  return leaseFailures.get(businessId) ?? null;
}

function rememberLeaseFailure(businessId: string, failure: DeviceLeaseFailure): void {
  leaseFailures.set(businessId, failure);
}

function clearLeaseFailure(businessId: string): void {
  leaseFailures.delete(businessId);
}

interface ApiFailureShape {
  status?: unknown;
  code?: unknown;
  message?: unknown;
  data?: unknown;
  response?: { data?: unknown };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalise the HTTP-client error into a user-presentable lease failure.
 * Desktop injects its own ApiError shape; mobile/core may inject another, so
 * inspect both the error and the backend `{ error: { code, message, details } }`
 * envelope instead of relying on one class.
 */
export function classifyDeviceLeaseFailure(error: unknown): DeviceLeaseFailure {
  const e = (asRecord(error) ?? {}) as ApiFailureShape;
  const responseData = asRecord(e.data) ?? asRecord(e.response?.data);
  const errorBody = asRecord(responseData?.error);
  const details = asRecord(errorBody?.details);
  const status = asNumber(e.status);
  const code =
    typeof errorBody?.code === "string"
      ? errorBody.code
      : typeof e.code === "string"
        ? e.code
        : undefined;
  const message =
    typeof errorBody?.message === "string"
      ? errorBody.message
      : typeof e.message === "string"
        ? e.message
        : "";
  const limit = asNumber(details?.limit);
  const current = asNumber(details?.current);

  if (status === 402 || code === "TERMINAL_LIMIT_REACHED") {
    return {
      code: "TERMINAL_LIMIT_REACHED",
      message:
        message ||
        "This business has reached the number of linked terminals allowed by its plan.",
      status,
      limit,
      current,
    };
  }

  if (status === 429 || code === "DEVICE_LIMIT_REACHED") {
    return {
      code: "DEVICE_LIMIT_REACHED",
      message: message || "This business has reached the maximum number of linked terminals.",
      status,
    };
  }

  if (
    status === 401 ||
    message.includes("TOKEN_MISSING") ||
    message.includes("No authentication token")
  ) {
    return {
      code: "AUTH_REQUIRED",
      message: message || "Sign-in is still finishing. Retry in a moment.",
      status,
    };
  }

  return {
    code: "LEASE_FAILED",
    message: message || "The terminal could not be activated.",
    status,
  };
}

export function getDeviceNumber(businessId: string): string | null {
  const v = getSync<string>(LEASE_KEY(businessId));
  return isPosDeviceNumber(v) ? v : null;
}

export function isOnlineOnly(businessId: string): boolean {
  return getDeviceNumber(businessId) == null;
}

export async function ensureLease(businessId: string): Promise<string | null> {
  // Offline-first: keep leased DD even offline — if online check/lease fails, return cached
  const existingSync = getDeviceNumber(businessId);
  if (existingSync) {
    clearLeaseFailure(businessId);
    // Opportunistically refresh touch if online, but never discard cached on failure
    if (getConnectivityState().isOnline) {
      try {
        const leasedAt = getSync<string>(`${LEASE_KEY(businessId)}:leased_at`);
        const needsRefresh = !leasedAt || Date.now() - new Date(leasedAt).getTime() > LEASE_TTL_MS - 24 * 60 * 60 * 1000;
        // Never make readiness wait on the refresh — a slow network must not
        // hold POS startup when a valid cached lease already exists.
        if (needsRefresh) void refreshLease(businessId).catch(() => {});
      } catch {
        // keep existing on any refresh failure
      }
    }
    return existingSync;
  }

  // No sync cache — try async KV (covers boot race where sync cache not yet hydrated from kv.json)
  try {
    const asyncCached = await getItem<string>(LEASE_KEY(businessId));
    if (isPosDeviceNumber(asyncCached)) {
      // hydrate sync cache for next getDeviceNumber calls
      try { setSync(LEASE_KEY(businessId), asyncCached); } catch {}
      clearLeaseFailure(businessId);
      return asyncCached;
    }
  } catch {}

  // No cached DD — must lease online. If offline, keep null (caller blocks POS with clear message)
  if (!getConnectivityState().isOnline) {
    syncLogger.debug("DeviceLease", "Offline and no cached DD — need online once", { businessId });
    rememberLeaseFailure(businessId, {
      code: "OFFLINE",
      message: "Connect to the internet once so this terminal can be activated.",
    });
    return null;
  }

  try {
    const http = getHttpClient();
    const deviceUuid = await getAppInstanceIdAsync();
    const res = await http.post<{ data: LeaseResponse } | LeaseResponse>(
      `/businesses/${businessId}/devices/lease`,
      { device_uuid: deviceUuid, app_instance_id: deviceUuid },
    );
    const payload = res.data as LeaseResponse & { data?: LeaseResponse };
    const data = payload.data ?? payload;
    const dn = data.device_number;
    if (isPosDeviceNumber(dn)) {
      setSync(LEASE_KEY(businessId), dn);
      setSync(`${LEASE_KEY(businessId)}:leased_at`, new Date().toISOString());
      try { await getItem<string>(LEASE_KEY(businessId)); } catch {}
      clearLeaseFailure(businessId);
      syncLogger.info("DeviceLease", "Leased device number", { businessId, device_number: dn });
      return dn;
    }

    rememberLeaseFailure(businessId, {
      code: "LEASE_FAILED",
      message: "The server did not return a terminal number. Try again.",
    });
  } catch (e) {
    const failure = classifyDeviceLeaseFailure(e);
    rememberLeaseFailure(businessId, failure);

    if (failure.code === "TERMINAL_LIMIT_REACHED" || failure.code === "DEVICE_LIMIT_REACHED") {
      syncLogger.warn("DeviceLease", "Terminal limit reached — activation needs a free slot", {
        businessId,
        code: failure.code,
        limit: failure.limit,
        current: failure.current,
      });
      return cachedLeaseFallback(businessId);
    }

    if (failure.code === "AUTH_REQUIRED") {
      syncLogger.debug("DeviceLease", "No auth yet — lease deferred until login", { businessId });
      return cachedLeaseFallback(businessId);
    }

    // Network/offline failure while leasing — keep any cached that may exist.
    syncLogger.warn("DeviceLease", "Lease failed — keep cached if any", {
      businessId,
      error: String(e),
    });
    return cachedLeaseFallback(businessId);
  }

  return cachedLeaseFallback(businessId);
}

async function cachedLeaseFallback(businessId: string): Promise<string | null> {
  try {
    const fallback = await getItem<string>(LEASE_KEY(businessId));
    if (isPosDeviceNumber(fallback)) {
      try { setSync(LEASE_KEY(businessId), fallback); } catch {}
      clearLeaseFailure(businessId);
      return fallback;
    }
  } catch {}

  const again = getDeviceNumber(businessId);
  if (again) {
    clearLeaseFailure(businessId);
    return again;
  }

  return null;
}

export async function refreshLease(businessId: string): Promise<void> {
  const dn = getDeviceNumber(businessId);
  if (!dn) {
    await ensureLease(businessId);
    return;
  }
  const leasedAt = getSync<string>(`${LEASE_KEY(businessId)}:leased_at`);
  if (leasedAt && Date.now() - new Date(leasedAt).getTime() < LEASE_TTL_MS - 24 * 60 * 60 * 1000) {
    return;
  }
  try {
    const http = getHttpClient();
    const uuid = await getAppInstanceIdAsync();
    await http.patch(`/businesses/${businessId}/devices/${uuid}/touch`, {});
    setSync(`${LEASE_KEY(businessId)}:leased_at`, new Date().toISOString());
  } catch {
    // ignore — will retry next boot
  }
}

export function clearLeaseForTests(businessId: string): void {
  removeItemSync(LEASE_KEY(businessId));
  removeItemSync(`${LEASE_KEY(businessId)}:leased_at`);
  clearLeaseFailure(businessId);
}

export const deviceLeaseService = {
  getDeviceNumber,
  isOnlineOnly,
  ensureLease,
  refreshLease,
  getAppInstanceId: getAppInstanceIdAsync,
  getAppInstanceIdAsync,
};
