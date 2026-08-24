/**
 * Local order number allocation for offline/LAN operation.
 *
 * When the cloud is unreachable, the Local Node (or the local device if there
 * is no Local Node) assigns temporary order numbers with the prefix
 * `TFL-YYYYMMDD-NNNN`. These are reconciled with permanent cloud order numbers
 * once connectivity returns.
 */

import { getItemSync as getItem, setItemSync as setItem } from "../adapters/kv";

const LOCAL_ORDER_SEQ_KEY = "local_order_sequence";
const LOCAL_CALLOUT_SEQ_KEY = "local_callout_sequence";

function formatDatePart(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function getNextSequence(datePart: string, key: string): number {
  const stored = getItem<Record<string, number>>(key);
  const map = stored ?? {};
  const next = (map[datePart] ?? 0) + 1;
  map[datePart] = next;
  // Keep only the last 7 days to avoid unbounded growth.
  const cutoff = String(Number(datePart) - 7);
  for (const mapKey of Object.keys(map)) {
    if (mapKey < cutoff) {
      delete map[mapKey];
    }
  }
  setItem(key, map);
  return next;
}

/**
 * Generate a local order number for offline-created orders.
 */
export function generateLocalOrderNumber(date = new Date()): string {
  const datePart = formatDatePart(date);
  const seq = getNextSequence(datePart, LOCAL_ORDER_SEQ_KEY);
  return `TFL-${datePart}-${String(seq).padStart(4, "0")}`;
}

/**
 * Generate a local callout number for offline-created orders.
 */
export function generateLocalCalloutNumber(date = new Date()): number {
  const datePart = formatDatePart(date);
  return getNextSequence(datePart, LOCAL_CALLOUT_SEQ_KEY);
}

/**
 * Check whether an order number was locally allocated.
 */
export function isLocalOrderNumber(orderNumber: string): boolean {
  return orderNumber.startsWith("TFL-");
}
