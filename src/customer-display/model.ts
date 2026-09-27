/**
 * Customer display model — a platform-agnostic snapshot of what the
 * customer-facing screen should show. The merchant POS owns order/payment
 * state; this module only *describes* that state so any presentation layer
 * (Tauri second window, Android `Presentation`, future hardware) renders it
 * identically. No hardware or framework details live here.
 */

export type CustomerDisplayPhase =
  | "idle"
  | "ordering"
  | "payment"
  | "confirmation";

export type CustomerDisplayPaymentMethod =
  | "cash"
  | "mobile_money"
  | "card"
  | "split"
  | "other";

export type CustomerDisplayPaymentStatus =
  | "pending"
  | "processing"
  | "paid"
  | "failed";

export interface CustomerDisplayLineItem {
  /** Stable key for list rendering. */
  id: string;
  name: string;
  variant?: string;
  addons: string[];
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface CustomerDisplayTaxLine {
  id?: string;
  name: string;
  amountMinor: number;
  inclusive?: boolean;
}

export interface CustomerDisplayPayment {
  method: CustomerDisplayPaymentMethod;
  status: CustomerDisplayPaymentStatus;
  /** Optional hosted-checkout / QR URL the customer can scan. */
  qrUrl?: string | null;
}

export interface CustomerDisplayConfirmation {
  orderNumber: string;
  totalMinor: number;
  currency: string;
  /** Epoch ms; used to auto-dismiss back to idle. */
  at: number;
}

export interface CustomerDisplayBranding {
  name: string;
  logoUrl?: string | null;
  /** Optional promo / tagline shown on the idle screen. */
  tagline?: string | null;
}

export interface CustomerDisplayModel {
  phase: CustomerDisplayPhase;
  branding: CustomerDisplayBranding | null;
  currency: string;
  items: CustomerDisplayLineItem[];
  itemCount: number;
  subtotalMinor: number;
  taxLines: CustomerDisplayTaxLine[];
  discountMinor: number;
  totalMinor: number;
  customerName?: string;
  orderType?: string;
  payment?: CustomerDisplayPayment;
  confirmation?: CustomerDisplayConfirmation;
  updatedAt: number;
}

export interface CustomerDisplayInput {
  branding: CustomerDisplayBranding | null;
  currency: string;
  items: CustomerDisplayLineItem[];
  subtotalMinor: number;
  taxLines: CustomerDisplayTaxLine[];
  discountMinor: number;
  totalMinor: number;
  customerName?: string;
  orderType?: string;
  /** Runtime overrides from the POS payment flow. */
  phase?: CustomerDisplayPhase;
  payment?: CustomerDisplayPayment;
  confirmation?: CustomerDisplayConfirmation;
  now?: number;
}

export const EMPTY_CUSTOMER_DISPLAY_MODEL: CustomerDisplayModel = {
  phase: "idle",
  branding: null,
  currency: "GHS",
  items: [],
  itemCount: 0,
  subtotalMinor: 0,
  taxLines: [],
  discountMinor: 0,
  totalMinor: 0,
  updatedAt: 0,
};

/**
 * Resolve the display phase from order + runtime state. Explicit runtime phase
 * (set by the POS flow) wins; otherwise the presence of items implies ordering.
 */
export function resolvePhase(input: CustomerDisplayInput): CustomerDisplayPhase {
  if (input.phase) return input.phase;
  return input.items.length > 0 ? "ordering" : "idle";
}

/** Pure builder — deterministic and safe to unit-test without any hardware. */
export function buildCustomerDisplayModel(
  input: CustomerDisplayInput,
): CustomerDisplayModel {
  const itemCount = input.items.reduce((sum, item) => sum + item.quantity, 0);
  return {
    phase: resolvePhase(input),
    branding: input.branding,
    currency: input.currency,
    items: input.items,
    itemCount,
    subtotalMinor: input.subtotalMinor,
    taxLines: input.taxLines,
    discountMinor: input.discountMinor,
    totalMinor: input.totalMinor,
    customerName: input.customerName,
    orderType: input.orderType,
    payment: input.payment,
    confirmation: input.confirmation,
    updatedAt: input.now ?? Date.now(),
  };
}
