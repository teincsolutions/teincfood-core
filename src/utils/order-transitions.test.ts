import { describe, it, expect } from "vitest";
import {
  isUnpaid,
  isCancellable,
  cancelLabelFor,
  getCancelAction,
  isQueuedResult,
  isDeliveryOrder,
  isWalkInPickup,
  nextActionFor,
  canTransition,
  getAllowedActions,
  CANCELLABLE_STATUSES,
  stageStatuses,
} from "./order-transitions";
import type { SellerOrder } from "../types/api/seller.api";

function order(overrides: Partial<SellerOrder> & { status: string; order_type?: string | null; delivery_id?: string | null; is_pos?: boolean; is_paid?: boolean; paid_at?: string | null; pos_payment_method?: string | null; payment?: unknown }): SellerOrder {
  return {
    id: "o1",
    order_number: "01-100-001",
    callout_number: 1,
    status: overrides.status,
    order_type: (overrides.order_type as string) ?? "takeout",
    is_pos: (overrides as { is_pos?: boolean }).is_pos ?? true,
    delivery_id: (overrides as { delivery_id?: string | null }).delivery_id ?? null,
    is_paid: (overrides as { is_paid?: boolean }).is_paid ?? false,
    paid_at: (overrides as { paid_at?: string | null }).paid_at ?? null,
    pos_payment_method: (overrides as { pos_payment_method?: string | null }).pos_payment_method ?? null,
    payment: (overrides.payment as SellerOrder["payment"]) ?? { is_paid: false, reference: null, amount_minor: 1000, currency: "GHS", paid_at: null },
    business_id: "biz1",
  } as unknown as SellerOrder;
}

describe("order-transitions", () => {
  it("CANCELLABLE includes ready (5)", () => {
    expect(CANCELLABLE_STATUSES).toEqual(["pending", "awaiting_payment", "accepted", "preparing", "ready"]);
    expect(isCancellable("ready")).toBe(true);
    expect(isCancellable("delivered")).toBe(false);
  });

  it("cancelLabelFor pending=Reject else Cancel", () => {
    expect(cancelLabelFor("pending")).toBe("Reject");
    expect(cancelLabelFor("accepted")).toBe("Cancel");
    expect(cancelLabelFor("ready")).toBe("Cancel");
    expect(getCancelAction("pending")).toBe("reject");
    expect(getCancelAction("ready")).toBe("cancel");
  });

  it("isUnpaid 3-way — payment.is_paid stale", () => {
    expect(isUnpaid(order({ status: "pending", is_paid: false, paid_at: null, payment: { is_paid: false } as any }))).toBe(true);
    expect(isUnpaid(order({ status: "pending", is_paid: false, paid_at: null, payment: { is_paid: true } as any }))).toBe(false);
    expect(isUnpaid(order({ status: "pending", is_paid: true, paid_at: "2026-01-01T00:00:00Z", payment: { is_paid: true } as any }))).toBe(false);
    expect(isUnpaid(order({ status: "pending", is_paid: false, paid_at: "2026-01-01T00:00:00Z", payment: { is_paid: false } as any }))).toBe(false);
  });

  it("isUnpaid cash POS orders are always paid", () => {
    expect(isUnpaid(order({ status: "pending", is_paid: false, paid_at: null, pos_payment_method: "cash", payment: { is_paid: false } as any }))).toBe(false);
  });

  it("isDeliveryOrder vs isWalkInPickup", () => {
    expect(isDeliveryOrder(order({ status: "ready", order_type: "delivery", delivery_id: null }))).toBe(true);
    expect(isDeliveryOrder(order({ status: "ready", order_type: "takeout", delivery_id: null, is_pos: true }))).toBe(false);
    expect(isDeliveryOrder(order({ status: "ready", order_type: "takeout", delivery_id: "d1" } as any))).toBe(true); // delivery_id implies delivery
    expect(isWalkInPickup(order({ status: "ready", order_type: "takeout" }))).toBe(true);
    expect(isWalkInPickup(order({ status: "ready", order_type: "dine_in" }))).toBe(true);
    expect(isWalkInPickup(order({ status: "ready", order_type: "delivery" }))).toBe(false);
  });

  it("isQueuedResult", () => {
    expect(isQueuedResult({ status: "pending", command_id: "cmd_1" })).toBe(true);
    expect(isQueuedResult({ status: "pending", command_id: "cmd_1", id: "uuid" })).toBe(false);
    expect(isQueuedResult(null)).toBe(false);
  });

  it("nextActionFor pipeline + awaiting_payment null + ready walk-in label", () => {
    expect(nextActionFor(order({ status: "pending", is_pos: false }))).toEqual({ label: "Accept", key: "accept" });
    expect(nextActionFor(order({ status: "pending", is_pos: true }))).toEqual({ label: "Start preparing", key: "start_preparing" });
    expect(nextActionFor(order({ status: "accepted" }))).toEqual({ label: "Start preparing", key: "start_preparing" });
    expect(nextActionFor(order({ status: "preparing" }))).toEqual({ label: "Mark ready", key: "mark_ready" });
    expect(nextActionFor(order({ status: "ready", order_type: "dine_in" }))).toEqual({ label: "Complete", key: "complete_pickup" });
    expect(nextActionFor(order({ status: "ready", order_type: "takeout" }))).toEqual({ label: "Picked up", key: "complete_pickup" });
    expect(nextActionFor(order({ status: "awaiting_payment" }))).toBeNull();
    expect(nextActionFor(order({ status: "cancelled" }))).toBeNull();
    expect(nextActionFor(order({ status: "delivered" }))).toBeNull();
  });

  it("nextActionFor ready delivery NEVER offers complete_pickup (backend 422 otherwise)", () => {
    const delNoRider = order({ status: "ready", order_type: "delivery", delivery_id: null, is_pos: false });
    expect(nextActionFor(delNoRider)).toEqual({ label: "Assign rider", key: "assign_rider" });
    const delWithRider = order({ status: "ready", order_type: "delivery", delivery_id: "d1", is_pos: false } as any);
    expect(nextActionFor(delWithRider)).toEqual({ label: "Handover to rider", key: "confirm_handover" });
    const waitingPickup = order({ status: "waiting_pickup", order_type: "delivery", delivery_id: "d1", is_pos: false } as any);
    expect(nextActionFor(waitingPickup)).toEqual({ label: "Handover to rider", key: "confirm_handover" });
    const walkWaiting = order({ status: "waiting_pickup", order_type: "takeout", delivery_id: null });
    expect(nextActionFor(walkWaiting)).toBeNull();
  });

  it("canTransition: walk-in ready complete_pickup vs delivery assign/handover", () => {
    const walkReady = order({ status: "ready", order_type: "takeout", delivery_id: null, is_pos: true });
    const delReadyNoRider = order({ status: "ready", order_type: "delivery", delivery_id: null });
    const delReadyWithRider = order({ status: "ready", order_type: "delivery", delivery_id: "d1" } as any);
    expect(canTransition(walkReady, "complete_pickup")).toBe(true);
    expect(canTransition(walkReady, "assign_rider")).toBe(false);
    expect(canTransition(walkReady, "confirm_handover")).toBe(false);
    expect(canTransition(delReadyNoRider, "assign_rider")).toBe(true);
    expect(canTransition(delReadyNoRider, "complete_pickup")).toBe(false);
    expect(canTransition(delReadyWithRider, "confirm_handover")).toBe(true);
    expect(canTransition(delReadyWithRider, "assign_rider")).toBe(false);
  });

  it("canTransition: awaiting_payment only pay/confirm_cash/cancel", () => {
    const aw = order({ status: "awaiting_payment", is_paid: false, paid_at: null, payment: { is_paid: false } as any });
    expect(canTransition(aw, "pay")).toBe(true);
    expect(canTransition(aw, "confirm_cash")).toBe(true);
    expect(canTransition(aw, "cancel")).toBe(true);
    expect(canTransition(aw, "accept")).toBe(false);
    expect(canTransition(aw, "start_preparing")).toBe(false);
  });

  it("getAllowedActions: pending → accept/reject (online) vs start_preparing (is_pos), ready walk-in → complete_pickup+cancel+confirm_cash if unpaid, ready delivery → assign/confirm", () => {
    expect(getAllowedActions(order({ status: "pending", is_pos: false }))).toEqual(["accept", "reject"]);
    expect(getAllowedActions(order({ status: "pending", is_pos: true }))).toEqual(expect.arrayContaining(["start_preparing"]));
    expect(getAllowedActions(order({ status: "accepted" }))).toEqual(expect.arrayContaining(["start_preparing", "cancel"]));
    expect(getAllowedActions(order({ status: "preparing" }))).toEqual(expect.arrayContaining(["mark_ready", "cancel"]));
    const walkReadyUnpaid = order({ status: "ready", order_type: "takeout", delivery_id: null, is_paid: false, paid_at: null, payment: { is_paid: false } as any });
    expect(getAllowedActions(walkReadyUnpaid)).toEqual(expect.arrayContaining(["complete_pickup", "cancel", "confirm_cash"]));
    const delNoRider = order({ status: "ready", order_type: "delivery", delivery_id: null });
    expect(getAllowedActions(delNoRider)).toEqual(expect.arrayContaining(["assign_rider"]));
    const delWithRider = order({ status: "ready", order_type: "delivery", delivery_id: "d1" } as any);
    expect(getAllowedActions(delWithRider)).toEqual(expect.arrayContaining(["confirm_handover"]));
    expect(getAllowedActions(order({ status: "awaiting_payment" }))).toEqual(expect.arrayContaining(["pay", "confirm_cash", "cancel"]));
    expect(getAllowedActions(order({ status: "cancelled" }))).toEqual([]);
  });

  it("stageStatuses derives hierarchical done/current/upcoming", () => {
    expect(stageStatuses("pending").map((s) => s.state)).toEqual([
      "current",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
    expect(stageStatuses("preparing").map((s) => s.state)).toEqual([
      "done",
      "done",
      "current",
      "upcoming",
      "upcoming",
    ]);
    expect(stageStatuses("delivered").every((s) => s.state !== "upcoming")).toBe(true);
  });

  it("stageStatuses yields all upcoming for off-pipeline statuses", () => {
    for (const status of ["cancelled", "awaiting_payment", "waiting_pickup"]) {
      expect(stageStatuses(status).map((s) => s.state)).toEqual([
        "upcoming",
        "upcoming",
        "upcoming",
        "upcoming",
        "upcoming",
      ]);
    }
  });
});
