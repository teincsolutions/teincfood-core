/**
 * Device lease service: DD 01-99 per business.
 * Backend authority: POST /businesses/:id/devices/lease
 * KV persists device_number per businessId.
 */

import { getItemSync as getSync, setItemSync as setSync } from "../adapters/kv";
import { getHttpClient, ApiError } from "../adapters/http";
import { generateUUID } from "../utils/uuid";
import { syncLogger } from "../utils/sync-logger";

const LEASE_KEY = (businessId: string) => `teinc_device_number:${businessId}`;
const LEASE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface LeaseResponse {
  device_number: string;
  device_uuid: string;
}

function getAppInstanceId(): string {
  let id = getSync<string>("teinc_app_instance_id");
  if (!id) {
    id = generateUUID();
    setSync("teinc_app_instance_id", id);
  }
  return id;
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
  const existing = getDeviceNumber(businessId);
  if (existing) return existing;

  try {
    const http = getHttpClient();
    const deviceUuid = getAppInstanceId();
    const res = await http.post<{ data: LeaseResponse } | LeaseResponse>(
      `/businesses/${businessId}/devices/lease`,
      { device_uuid: deviceUuid, app_instance_id: deviceUuid },
    );
    const data: LeaseResponse = (res.data as unknown as { data: LeaseResponse })?.data ?? (res.data as unknown as LeaseResponse);
    const dn = (data as LeaseResponse).device_number;
    if (dn && /^(0[1-9]|[1-9][0-9])$/.test(dn)) {
      setSync(LEASE_KEY(businessId), dn);
      setSync(`${LEASE_KEY(businessId)}:leased_at`, new Date().toISOString());
      syncLogger.info("DeviceLease", "Leased device number", { businessId, device_number: dn });
      return dn;
    }
  } catch (e) {
    const apiErr = e as { status?: number; name?: string };
    if (apiErr?.status === 429 || (e as Error)?.message?.includes("DEVICE_LIMIT_REACHED")) {
      syncLogger.warn("DeviceLease", "Device limit reached — online only", { businessId });
      return null;
    }
    syncLogger.warn("DeviceLease", "Lease failed — will operate online-only until next boot", {
      businessId,
      error: String(e),
    });
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
    await http.patch(`/businesses/${businessId}/devices/${getAppInstanceId()}/touch`, {});
    setSync(`${LEASE_KEY(businessId)}:leased_at`, new Date().toISOString());
  } catch {
    // ignore — will retry next boot
  }
}

export function clearLeaseForTests(businessId: string): void {
  // test helper
  const { removeItemSync } = require("../adapters/kv");
  removeItemSync(LEASE_KEY(businessId));
  removeItemSync(`${LEASE_KEY(businessId)}:leased_at`);
}

export const deviceLeaseService = {
  getDeviceNumber,
  isOnlineOnly,
  ensureLease,
  refreshLease,
  getAppInstanceId,
};
