/**
 * POS types — minimal shapes used by sync transports and repositories.
 */

export interface POSOrderItem {
  menu_item_id: string;
  quantity: number;
  addons?: unknown[];
}

export interface POSOrderCreateRequest {
  items: POSOrderItem[];
  order_type?: string;
  customer_name?: string | null;
  customer_phone?: string | null;
  pos_payment_method?: string;
  total_minor?: number;
  order_number?: string;
  command_id?: string;
  local_order_number?: string;
  [key: string]: unknown;
}

export interface POSOrderPreviewRequest {
  items: POSOrderItem[];
  order_type: string;
  customer_name?: string;
  [key: string]: unknown;
}

export interface POSOrderPreviewResponse {
  total_minor: number;
  subtotal_minor: number;
  tax_minor: number;
  delivery_fee_minor: number;
  [key: string]: unknown;
}
