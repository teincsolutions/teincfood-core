import type { MenuItem, MenuItemVariantResponse, MenuItemAddonResponse, MenuCategory } from "./api/menu.api";
import type { SellerOrder, OrderItem } from "./api/seller.api";
import type { OrderTaxLine } from "./api/seller.api";

export type POSOrderType = "takeout" | "dine_in";
export type POSPaymentMethod = "cash" | "mobile_money";

export interface POSSelectedAddon {
  addon_id: string;
  name: string;
  price_minor: number;
}

export interface POSCartItem {
  id: string;
  menu_item: MenuItem;
  quantity: number;
  selected_variant: MenuItemVariantResponse | null;
  selected_addons: POSSelectedAddon[];
  notes: string;
  unit_price_minor: number;
}

export interface POSCartState {
  items: POSCartItem[];
  subtotal_minor: number;
  item_count: number;
}

export interface POSCheckoutForm {
  customer_name: string;
  customer_phone: string;
  order_type: POSOrderType;
  pos_payment_method: POSPaymentMethod;
}

/** Matches backend calculate_items input — server ignores extra keys */
export interface POSOrderItemRequest {
  menu_item_id: string;
  quantity: number;
  variant_id?: string;
  addon_ids?: string[];
}

export interface POSOrderCreateRequest {
  order_type: POSOrderType;
  customer_name: string;
  customer_phone: string;
  pos_payment_method: POSPaymentMethod;
  items: POSOrderItemRequest[];
  notes?: string;
  /** Client-generated command id for offline idempotency */
  command_id?: string;
  /** Locally allocated order number when created offline */
  local_order_number?: string;
  [key: string]: unknown;
}

export interface POSOrderPreviewRequest {
  items: POSOrderItemRequest[];
  order_type?: POSOrderType;
  customer_name?: string;
  [key: string]: unknown;
}

export interface POSPricing {
  subtotal_minor: number;
  discounted_subtotal_minor: number;
  delivery_fee_minor: number;
  tax_minor: number;
  exclusive_tax_minor?: number;
  tip_minor: number;
  discount_minor: number;
  total_minor: number;
  currency_code: string;
  promo_code?: string | null;
  tax_lines: OrderTaxLine[];
}

export interface POSOrderPreviewResponse {
  data: POSPricing;
}

export interface POSOrderCreateResponse {
  data: SellerOrder;
}

// Legacy alias used by older sync code
export interface POSOrderItem {
  menu_item_id: string;
  quantity: number;
  addons?: unknown[];
}

export type { SellerOrder, OrderItem };
