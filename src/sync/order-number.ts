/**
 * Universal order number: DD-NNNN-MMM (11 chars)
 * DD = device number 01-99 (leased per business)
 * NNNN = block number 0001-9999, increments after MMM reaches 999
 * MMM = order sequence 001-999 inside the current block
 *
 * Examples: "10-0001-001" ... "10-0001-999", "10-0002-001".
 *
 * The sequence is persisted per business (per device install), so it survives
 * restarts. Legacy DD-RRR-CCC numbers (7-digit order part) are still accepted
 * when reading old rows; only new numbers use the block format.
 */

import { getItemSync as getItem, setItemSync as setItem } from "../adapters/kv";
import { getDeviceNumber } from "./device-lease.service";

const CALLOUT_SEQ_KEY = "teinc_callout_seq";
const ORDERS_PER_BLOCK = 999;
const MAX_BLOCKS = 9999;
const MAX_SEQUENCE = ORDERS_PER_BLOCK * MAX_BLOCKS;

function calloutKeyForBusiness(businessId?: string | null): string {
  return businessId ? `${CALLOUT_SEQ_KEY}:${businessId}` : CALLOUT_SEQ_KEY;
}

/** Last consumed sequence number for this business (0 when brand new). */
function getStoredSequence(businessId?: string | null): number {
  const key = calloutKeyForBusiness(businessId);
  // Per-business isolation matters: the legacy global key is a mirror only,
  // never the starting point for another business (that would leak a
  // sequence across tenants on the same install).
  return Number(getItem<number>(key) ?? 0) || 0;
}

function sequenceParts(sequence: number): { block: number; callout: number } {
  const zero = Math.max(0, sequence - 1);
  return {
    block: Math.floor(zero / ORDERS_PER_BLOCK) + 1,
    callout: (zero % ORDERS_PER_BLOCK) + 1,
  };
}

function getNextSequence(businessId?: string | null): number {
  const key = calloutKeyForBusiness(businessId);
  const next = getStoredSequence(businessId) + 1;
  if (next > MAX_SEQUENCE) {
    throw new Error(`Order number sequence exhausted for business ${businessId ?? "global"}`);
  }
  setItem(key, next);
  // Keep the legacy global key in sync for older readers, but never let a
  // different business reset it downwards.
  if (businessId) {
    const legacy = Number(getItem<number>(CALLOUT_SEQ_KEY) ?? 0) || 0;
    if (legacy < next) setItem(CALLOUT_SEQ_KEY, next);
  }
  return next;
}

/** Current (last generated) callout number, for receipt/display fallbacks. */
export function peekCallout(businessId?: string | null): number {
  const stored = getStoredSequence(businessId);
  return stored > 0 ? sequenceParts(stored).callout : 0;
}

export function generateOrderNumber(
  deviceNumber: string,
  businessId?: string | null,
): { orderNumber: string; callout: number; block: number; sequence: number } {
  if (!/^(0[1-9]|[1-9][0-9])$/.test(deviceNumber)) {
    throw new Error(`Invalid deviceNumber ${deviceNumber} — must be 01-99`);
  }
  const sequence = getNextSequence(businessId);
  const { block, callout } = sequenceParts(sequence);
  const orderNumber = `${deviceNumber}-${String(block).padStart(4, "0")}-${String(callout).padStart(3, "0")}`;
  return { orderNumber, callout, block, sequence };
}

// No legacy fallback — 0.7.0 requires business-scoped device lease via device-lease.service.
// Kept for internal compat only; callers must supply businessId via generateOrderNumberForBusiness.
export function generateLocalOrderNumber(): string {
  // 0.7.0: do not silently use 99. Throw so caller wires businessId.
  throw new Error("generateLocalOrderNumber removed in 0.7.0 — use generateOrderNumberForBusiness(businessId)");
}

export function generateOrderNumberForBusiness(businessId: string): string {
  // getDeviceNumber rejects DD 01 (reserved for online orders), so a stale
  // cached 01 can never generate a POS order number that collides with the
  // buyer app. The caller must lease a real POS device (02-99) online first.
  const v = getDeviceNumber(businessId);
  if (!v) {
    throw new Error(`No POS device lease for business ${businessId} — call ensureLease(businessId) first (online-only until leased)`);
  }
  return generateOrderNumber(v, businessId).orderNumber;
}

export function generateLocalCalloutNumber(businessId?: string | null): number {
  // Kept for SellerOrder.callout_number compatibility — returns the callout
  // that the next generated order will use, without consuming it.
  const sequence = getStoredSequence(businessId) + 1;
  return sequenceParts(sequence).callout;
}

// Accept both the new DD-NNNN-MMM format and legacy DD-RRR-CCC rows.
export function isLocalOrderNumber(orderNumber: string): boolean {
  return /^[0-9]{2}-[0-9]{3,4}-[0-9]{3}$/.test(orderNumber);
}

export function isOfflineOrderNumber(orderNumber: string): boolean {
  return isLocalOrderNumber(orderNumber);
}

export function parseOrderNumber(
  orderNumber: string,
): { deviceNumber: string; block: string; callout: string } | null {
  const m = orderNumber.match(/^([0-9]{2})-([0-9]{3,4})-([0-9]{3})$/);
  if (!m) return null;
  return {
    deviceNumber: m[1],
    // Normalise legacy 3-digit middles to the new 4-digit block shape.
    block: m[2].padStart(4, "0"),
    callout: m[3],
  };
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
