/**
 * Business-configurable fulfilment flow for terminal / business-app orders.
 *
 * Buyer-placed online orders always use the full pipeline
 * (accept → preparing → ready → completed). Orders rung up on a POS terminal
 * or in the business app follow the business setting:
 *
 *   "staged" (default) — same pipeline as online orders.
 *   "direct"           — the sale is completed the moment it is taken, so the
 *                        order is born `delivered` and no pipeline buttons are
 *                        offered.
 *
 * The setting lives on the business (`businesses.pos_order_flow`) and is
 * cached in the `business:profile` reference record, so it is readable while
 * offline.
 */

import type { SQLiteDatabase } from "../../adapters/sqlite";
import { openSyncDatabase } from "../../db/connection";
import { getReferenceData } from "../../reference/operations";

export type OrderFlowMode = "staged" | "direct";

export const DEFAULT_ORDER_FLOW_MODE: OrderFlowMode = "staged";

/** Coerce any server/local value into a known mode. */
export function normalizeOrderFlowMode(value: unknown): OrderFlowMode {
  return value === "direct" ? "direct" : DEFAULT_ORDER_FLOW_MODE;
}

export function isDirectOrderFlow(value: unknown): boolean {
  return normalizeOrderFlowMode(value) === "direct";
}

/**
 * Read `pos_order_flow` out of a `business:profile` payload. Accepts both the
 * reference-data envelope (`{ data: {...} }`) and a bare profile object.
 */
export function orderFlowModeFromProfile(payload: unknown): OrderFlowMode {
  if (!payload || typeof payload !== "object") return DEFAULT_ORDER_FLOW_MODE;
  const record = payload as {
    pos_order_flow?: unknown;
    data?: { pos_order_flow?: unknown } | null;
  };
  return normalizeOrderFlowMode(
    record.data?.pos_order_flow ?? record.pos_order_flow,
  );
}

/**
 * Cached business flow mode (works fully offline). Falls back to "staged" when
 * the profile has never been synced — the safe, full-pipeline default.
 */
export async function getBusinessOrderFlowMode(
  businessId: string,
  db?: SQLiteDatabase,
): Promise<OrderFlowMode> {
  if (!businessId) return DEFAULT_ORDER_FLOW_MODE;
  try {
    const connection = db ?? (await openSyncDatabase());
    const record = await getReferenceData<Record<string, unknown>>(
      connection,
      businessId,
      "business:profile",
    );
    return orderFlowModeFromProfile(record?.payload);
  } catch {
    return DEFAULT_ORDER_FLOW_MODE;
  }
}

/**
 * Status a POS/business-app order starts in.
 *
 * Cash sales in direct flow are complete on creation, except delivery orders:
 * those must always enter the rider pipeline. Anything that still needs money
 * (mobile money / card) must stay `awaiting_payment` first — the backend moves
 * it to `accepted` (staged/delivery) or `delivered` (direct walk-in) once the
 * payment lands.
 */
export function initialPosOrderStatus(
  paymentMethod: string | null | undefined,
  mode: OrderFlowMode,
  orderType: string | null | undefined = "takeout",
): "accepted" | "awaiting_payment" | "delivered" {
  const method = paymentMethod ?? "cash";
  if (method !== "cash") return "awaiting_payment";
  if (orderType === "delivery") return "accepted";
  return mode === "direct" ? "delivered" : "accepted";
}
