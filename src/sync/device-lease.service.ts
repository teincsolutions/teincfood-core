/**
 * Device lease service: DD 01-99 per business.
 * Backend authority: POST /businesses/:id/devices/lease
 * KV persists device_number per businessId.
 */

import { getItemSync as getSync, setItemSync as setSync, removeItemSync, getItem } from "../adapters/kv";
import { getHttpClient, ApiError } from "../adapters/http";
import { syncLogger } from "../utils/sync-logger";
import { getAppInstanceIdAsync } from "../adapters/devices";
import { getConnectivityState } from "../adapters/connectivity";

const LEASE_KEY = (businessId: string) => `teinc_device_number:${businessId}`;
const LEASE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface LeaseResponse {
  device_number: string;
  device_uuid: string;
}

export function getDeviceNumber(businessId: string): string | null {
  const v = getSync<string>(LEASE_KEY(businessId));
  if (v && /^(0[1-9]|[1-9][0-9])$/.test(v)) return v;
  return null;
}

export function isOnlineOnly(businessId: string): boolean {
  return getDeviceNumber(businessId) == null;
}

export async function ensureLease(businessId: string): Promise<string | null> {
  // Offline-first: keep leased DD even offline — if online check/lease fails, return cached
  const existingSync = getDeviceNumber(businessId);
  if (existingSync) {
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
    if (asyncCached && /^(0[1-9]|[1-9][0-9])$/.test(asyncCached)) {
      // hydrate sync cache for next getDeviceNumber calls
      try { setSync(LEASE_KEY(businessId), asyncCached); } catch {}
      return asyncCached;
    }
  } catch {}

  // No cached DD — must lease online. If offline, keep null (caller blocks POS with clear message)
  if (!getConnectivityState().isOnline) {
    syncLogger.debug("DeviceLease", "Offline and no cached DD — need online once", { businessId });
    return null;
  }

  try {
    const http = getHttpClient();
    const deviceUuid = await getAppInstanceIdAsync();
    const res = await http.post<{ data: LeaseResponse } | LeaseResponse>(
      `/businesses/${businessId}/devices/lease`,
      { device_uuid: deviceUuid, app_instance_id: deviceUuid },
    );
    const data: LeaseResponse = (res.data as unknown as { data: LeaseResponse })?.data ?? (res.data as unknown as LeaseResponse);
    const dn = (data as LeaseResponse).device_number;
    if (dn && /^(0[1-9]|[1-9][0-9])$/.test(dn)) {
      setSync(LEASE_KEY(businessId), dn);
      setSync(`${LEASE_KEY(businessId)}:leased_at`, new Date().toISOString());
      try { await getItem<string>(LEASE_KEY(businessId)); } catch {}
      syncLogger.info("DeviceLease", "Leased device number", { businessId, device_number: dn });
      return dn;
    }
  } catch (e) {
    const apiErr = e as { status?: number; name?: string; code?: string };
    const msg = String((e as Error)?.message ?? "");
    const isAuth = apiErr?.status === 401 || msg.includes("TOKEN_MISSING") || msg.includes("No authentication token");
    if (isAuth) {
      syncLogger.debug("DeviceLease", "No auth yet — lease deferred until login", { businessId });
      // fallback to any async cache that may have appeared concurrently
      try {
        const fallback = await getItem<string>(LEASE_KEY(businessId));
        if (fallback && /^(0[1-9]|[1-9][0-9])$/.test(fallback)) return fallback;
      } catch {}
      const again = getDeviceNumber(businessId);
      if (again) return again;
      return null;
    }
    if (apiErr?.status === 429 || msg.includes("DEVICE_LIMIT_REACHED")) {
      syncLogger.warn("DeviceLease", "Device limit reached — online only", { businessId });
      return null;
    }
    // Network/offline failure while leasing — keep any cached that may exist
    syncLogger.warn("DeviceLease", "Lease failed — keep cached if any", {
      businessId,
      error: String(e),
    });
    try {
      const fallback = await getItem<string>(LEASE_KEY(businessId));
      if (fallback && /^(0[1-9]|[1-9][0-9])$/.test(fallback)) {
        try { setSync(LEASE_KEY(businessId), fallback); } catch {}
        return fallback;
      }
    } catch {}
    const again = getDeviceNumber(businessId);
    if (again) return again;
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
}

export const deviceLeaseService = {
  getDeviceNumber,
  isOnlineOnly,
  ensureLease,
  refreshLease,
  getAppInstanceId: getAppInstanceIdAsync,
  getAppInstanceIdAsync,
};
