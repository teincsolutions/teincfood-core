/**
 * Shared order transition business logic — single source.
 *
 * All TeincFood business apps (Business + Desktop) must use this module for
 * deciding valid transitions, next action, cancellability, payment display and
 * walk-in vs delivery branching. No per-app fork.
 *
 * UI markup stays per-app; this module is pure (no React/Tamagui/sonner).
 */
import type { SellerOrder } from "../types/api/seller.api";

export const ORDER_STATUSES = [
  "pending",
  "awaiting_payment",
  "accepted",
  "preparing",
  "ready",
  "waiting_pickup",
  "on_the_way",
  "arrived",
  "delivered",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

// 5 includes ready (buyer no-show). Locked per ans 1.
export const CANCELLABLE_STATUSES = [
  "pending",
  "awaiting_payment",
  "accepted",
  "preparing",
  "ready",
] as const;

export const PIPELINE = ["pending", "accepted", "preparing", "ready", "delivered"] as const;

export type OrderAction =
  | "accept"
  | "reject"
  | "start_preparing"
  | "mark_ready"
  | "complete_pickup"
  | "cancel"
  | "assign_rider"
  | "confirm_handover"
  | "confirm_cash"
  | "pay";

// ── Helpers ───────────────────────────────────────────────────────────────

export function isUnpaid(order: SellerOrder): boolean {
  const o = order as unknown as { is_paid?: boolean; paid_at?: string | null; payment?: { is_paid?: boolean; paid_at?: string | null } };
  return !o.is_paid && !o.paid_at && !o.payment?.is_paid;
}

export function isCancellable(status: string): boolean {
  return (CANCELLABLE_STATUSES as readonly string[]).includes(status);
}

export function cancelLabelFor(status: string): string {
  if (status === "pending") return "Reject";
  return "Cancel";
}

export function getCancelAction(status: string): "reject" | "cancel" {
  return status === "pending" ? "reject" : "cancel";
}

export function isQueuedResult(result: unknown): boolean {
  const r = result as { status?: string; command_id?: string; id?: string } | null;
  if (!r) return false;
  return r.status === "pending" && !!r.command_id && !r.id;
}

export function isDeliveryOrder(order: Pick<SellerOrder, "order_type" | "delivery_id" | "is_pos">): boolean {
  const o = order as unknown as { order_type?: string | null; delivery_id?: string | null; is_pos?: boolean };
  if (o.order_type === "delivery") return true;
  return !!o.delivery_id;
}

export function isWalkInPickup(order: Pick<SellerOrder, "order_type" | "is_pos">): boolean {
  return !isDeliveryOrder(order as Pick<SellerOrder, "order_type" | "delivery_id" | "is_pos">);
}

// ── State machine ───────────────────────────────────────────────────────

const STATUS_TO_ACTION: Record<string, OrderAction> = {
  pending: "accept",
  accepted: "start_preparing",
  preparing: "mark_ready",
};

export function nextActionFor(order: SellerOrder): { label: string; key: OrderAction } | null {
  const status = (order as unknown as { status?: string }).status ?? "";
  // awaiting_payment must pay first — no pipeline progression
  if (status === "awaiting_payment") return null;
  if (status === "pending") return { label: "Accept", key: "accept" };
  if (status === "accepted") return { label: "Start preparing", key: "start_preparing" };
  if (status === "preparing") return { label: "Mark ready", key: "mark_ready" };
  if (status === "ready") {
    const orderType = (order as unknown as { order_type?: string | null }).order_type ?? null;
    // dine_in walk-in → Complete, else Pickup (takeout or delivery handover gate handled via getAllowedActions)
    const label = orderType === "dine_in" ? "Complete" : "Picked up";
    return { label, key: "complete_pickup" };
  }
  return null;
}

export function canTransition(order: SellerOrder, action: OrderAction): boolean {
  const status = (order as unknown as { status?: string }).status ?? "";
  if (status === "cancelled" || status === "delivered") return false;

  // awaiting_payment: only pay/confirm_cash/cancel/reject
  if (status === "awaiting_payment") {
    return action === "pay" || action === "confirm_cash" || action === "cancel" || action === "reject";
  }

  switch (action) {
    case "accept":
      return status === "pending";
    case "reject":
      return status === "pending";
    case "start_preparing":
      return status === "accepted" || status === "pending";
    case "mark_ready":
      return status === "preparing";
    case "complete_pickup":
      // walk-in only — delivery uses handover gates
      return status === "ready" && isWalkInPickup(order);
    case "cancel":
      return isCancellable(status);
    case "assign_rider":
      return status === "ready" && isDeliveryOrder(order) && !(order as unknown as { delivery_id?: string | null }).delivery_id;
    case "confirm_handover":
      return (status === "ready" || status === "waiting_pickup") && isDeliveryOrder(order) && !!(order as unknown as { delivery_id?: string | null }).delivery_id;
    case "confirm_cash":
    case "pay":
      return isUnpaid(order) && status !== "cancelled" && status !== "delivered";
    default:
      return false;
  }
}

export function getAllowedActions(order: SellerOrder): OrderAction[] {
  const status = (order as unknown as { status?: string }).status ?? "";
  if (status === "cancelled" || status === "delivered" || status === "arrived") return [];

  if (status === "awaiting_payment") {
    const actions: OrderAction[] = ["pay", "confirm_cash"];
    if (isCancellable(status)) actions.push("cancel");
    return actions;
  }

  if (status === "pending") {
    const actions: OrderAction[] = ["accept", "reject"];
    if (isCancellable(status)) {
      // reject already covers pending; cancel alias not needed
    }
    // Pending can also start preparing directly on some flows — expose via canTransition but primary is accept/reject
    return actions;
  }

  if (status === "accepted") {
    const actions: OrderAction[] = ["start_preparing"];
    if (isCancellable(status)) actions.push("cancel");
    return actions;
  }

  if (status === "preparing") {
    const actions: OrderAction[] = ["mark_ready"];
    if (isCancellable(status)) actions.push("cancel");
    return actions;
  }

  if (status === "ready") {
    if (isDeliveryOrder(order)) {
      const hasDelivery = !!(order as unknown as { delivery_id?: string | null }).delivery_id;
      if (!hasDelivery) return ["assign_rider", ...(isCancellable(status) ? ["cancel" as const] : [])];
      return ["confirm_handover", ...(isCancellable(status) ? ["cancel" as const] : [])];
    }
    // walk-in
    const actions: OrderAction[] = ["complete_pickup"];
    if (isCancellable(status)) actions.push("cancel");
    if (isUnpaid(order)) {
      // cash collect also allowed on ready walk-in
      actions.push("confirm_cash");
    }
    return actions;
  }

  if (status === "waiting_pickup" || status === "on_the_way") {
    if (isDeliveryOrder(order)) return ["confirm_handover"];
    return [];
  }

  return [];
}

// Re-export queued status map for callers that need it without importing sync internals
export const QUEUED_STATUS_BY_COMMAND: Record<string, string> = {
  "order:accept": "accepted",
  "order:reject": "cancelled",
  "order:start_preparing": "preparing",
  "order:mark_ready": "ready",
  "order:complete_pickup": "delivered",
  "order:cancel": "cancelled",
  "delivery:assign": "assigned",
  "delivery:confirm_handover": "delivered",
};

export function getQueuedStatus(commandType: string): string | null {
  return QUEUED_STATUS_BY_COMMAND[commandType] ?? null;
}
