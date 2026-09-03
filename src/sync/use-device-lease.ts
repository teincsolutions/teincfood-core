/**
 * 0.7.0 — auto-lease hook. Call once per active business.
 * Ensures device lease before any offline order is queued.
 * Apps should call ensureDeviceLease(businessId) after business selection/login.
 */

import { useEffect, useState } from "react";
import { ensureLease, getDeviceNumber } from "./device-lease.service";

export function useDeviceLease(businessId: string | null | undefined) {
  const [deviceNumber, setDeviceNumber] = useState<string | null>(null);
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;
    setLoading(true);
    const cached = getDeviceNumber(businessId);
    if (cached) {
      setDeviceNumber(cached);
      setOnlineOnly(false);
      setLoading(false);
      return;
    }
    ensureLease(businessId).then((dn) => {
      if (cancelled) return;
      setDeviceNumber(dn);
      setOnlineOnly(dn == null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [businessId]);

  return { deviceNumber, onlineOnly, loading };
}

export async function ensureDeviceLease(businessId: string): Promise<string | null> {
  const cached = getDeviceNumber(businessId);
  if (cached) return cached;
  return ensureLease(businessId);
}
