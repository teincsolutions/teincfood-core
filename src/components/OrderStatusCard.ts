import type { SellerOrder } from "../types/api/seller.api";

export interface OrderCardActions {
  onAccept?: (orderId: string) => void;
  onReject?: (orderId: string) => void;
  onStartPreparing?: (orderId: string) => void;
  onMarkReady?: (orderId: string) => void;
  onViewDetails?: (order: SellerOrder) => void;
  onPrint?: (order: SellerOrder) => void;
  onPay?: (order: SellerOrder) => void;
  onCollectCash?: (order: SellerOrder) => void;
  onCancel?: (order: SellerOrder) => void;
  onCompletePickup?: (orderId: string) => void;
}

export type PayingOrderId = string | null;

export function isUnpaid(order: SellerOrder): boolean {
  const o = order as unknown as { is_paid?: boolean; paid_at?: string | null; payment?: { is_paid?: boolean } };
  return !o.is_paid && !o.paid_at && !o.payment?.is_paid;
}

export function isCancellable(status: string): boolean {
  return ["pending", "awaiting_payment", "accepted", "preparing"].includes(status);
}

export function cancelLabelFor(status: string): string {
  if (status === "pending") return "Reject";
  return "Cancel";
}
