/**
 * Universal order number: DD-RRR-CCC (10 chars)
 * DD = device number 01-99 (leased per business)
 * RRR = random 100-999 per order (crypto)
 * CCC = callout 001-999 global monotonic per device, wraps to 001 (new RRR on wrap)
 * Example: "10-123-001"
 */

import { getItemSync as getItem, setItemSync as setItem } from "../adapters/kv";

const CALLOUT_SEQ_KEY = "teinc_callout_seq";
const ORDER_RANDOM_KEY = "teinc_last_random"; // last RRR for wrap logic debug

function cryptoRandom100to999(): number {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return 100 + (arr[0] % 900);
  }
  return 100 + Math.floor(Math.random() * 900);
}

function calloutKeyForBusiness(businessId?: string | null): string {
  return businessId ? `${CALLOUT_SEQ_KEY}:${businessId}` : CALLOUT_SEQ_KEY;
}

function getNextCallout(businessId?: string | null): number {
  const key = calloutKeyForBusiness(businessId);
  const stored = getItem<number>(key);
  let next = (stored ?? 0) + 1;
  if (next > 999) next = 1;
  setItem(key, next);
  // migrate legacy global once: keep global in sync for backward compat
  if (businessId) {
    const legacy = getItem<number>(CALLOUT_SEQ_KEY) ?? 0;
    if (legacy < next) setItem(CALLOUT_SEQ_KEY, next);
  }
  return next;
}

export function peekCallout(businessId?: string | null): number {
  const key = calloutKeyForBusiness(businessId);
  const v = getItem<number>(key);
  if (v != null) return v;
  const legacy = getItem<number>(CALLOUT_SEQ_KEY);
  return legacy ?? 0;
}

export function generateOrderNumber(deviceNumber: string, businessId?: string | null): { orderNumber: string; callout: number; random: number } {
  if (!/^(0[1-9]|[1-9][0-9])$/.test(deviceNumber)) {
    throw new Error(`Invalid deviceNumber ${deviceNumber} — must be 01-99`);
  }
  const callout = getNextCallout(businessId);
  let random = cryptoRandom100to999();
  // On wrap to 001, ensure new random (already new per order, but keep hook)
  if (callout === 1) {
    random = cryptoRandom100to999();
  }
  setItem(ORDER_RANDOM_KEY, random);
  const orderNumber = `${deviceNumber}-${String(random).padStart(3, "0")}-${String(callout).padStart(3, "0")}`;
  return { orderNumber, callout, random };
}

// No legacy fallback — 0.7.0 requires business-scoped device lease via device-lease.service.
// Kept for internal compat only; callers must supply businessId via generateOrderNumberForBusiness.
export function generateLocalOrderNumber(): string {
  // 0.7.0: do not silently use 99. Throw so caller wires businessId.
  throw new Error("generateLocalOrderNumber removed in 0.7.0 — use generateOrderNumberForBusiness(businessId)");
}

export function generateOrderNumberForBusiness(businessId: string): string {
  const v = getItem<string>(`teinc_device_number:${businessId}`);
  if (!v || !/^(0[1-9]|[1-9][0-9])$/.test(v)) {
    throw new Error(`No device lease for business ${businessId} — call ensureLease(businessId) first (online-only until leased)`);
  }
  return generateOrderNumber(v, businessId).orderNumber;
}

export function generateLocalCalloutNumber(businessId?: string | null): number {
  // kept for SellerOrder.callout_number compatibility — returns next CCC
  const next = peekCallout(businessId) + 1;
  return next > 999 ? 1 : next;
}

// New canonical check — unified for DD-RRR-CCC
export function isLocalOrderNumber(orderNumber: string): boolean {
  return /^[0-9]{2}-[0-9]{3}-[0-9]{3}$/.test(orderNumber);
}

export function isOfflineOrderNumber(orderNumber: string): boolean {
  return isLocalOrderNumber(orderNumber);
}

export function parseOrderNumber(orderNumber: string): { deviceNumber: string; random: string; callout: string } | null {
  const m = orderNumber.match(/^([0-9]{2})-([0-9]{3})-([0-9]{3})$/);
  if (!m) return null;
  return { deviceNumber: m[1], random: m[2], callout: m[3] };
}

// Test helpers
export function resetCalloutForTests(businessId?: string | null): void {
  if (businessId) {
    setItem(calloutKeyForBusiness(businessId), 0);
    return;
  }
  setItem(CALLOUT_SEQ_KEY, 0);
  // also clear per-business keys that tests may have touched
  // caller should pass businessId if they used business-scoped sequences
}
