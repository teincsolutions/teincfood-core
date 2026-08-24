import type { PaginatedResponse } from './pagination';

// ─── Order User ───

export interface OrderUser {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  avatar_url: string | null;
}

// ─── Payment Summary ───

export interface OrderPayment {
  is_paid: boolean;
  reference: string | null;
  amount_minor: number | null;
  currency: string | null;
  paid_at: string | null;
}

// ─── Menu Item Summary ───

export interface OrderMenuItem {
  id: string;
  name: string;
}

// ─── Order Item Addon ───

export interface OrderItemAddon {
  id: string;
  price: number;
}

// ─── Order Item ───

export interface OrderItem {
  id: string;
  menu_item: OrderMenuItem | null;
  quantity: number;
  unit_price: number;
  subtotal: number;
  addons?: OrderItemAddon[];
}

// ─── Business Summary ───

export interface OrderBusiness {
  id: string;
  name: string;
  phone?: string;
  latitude?: number;
  longitude?: number;
  estimated_delivery_time?: number;
}

// ─── Delivery Address ───

export interface OrderDeliveryAddress {
  apartment?: string;
  city?: string;
  full_address?: string;
  id?: string;
  label?: string;
  place_id?: string;
  street?: string;
  latitude?: number;
  longitude?: number;
}

// ─── Tax Line ───

export interface OrderTaxLine {
  id: string | null;
  business_tax_rule_id: string | null;
  name: string | null;
  code: string | null;
  country_code: string | null;
  rate_basis_points: number | null;
  taxable_amount_minor: number | null;
  tax_amount_minor: number | null;
  applies_to: string | null;
  is_inclusive: boolean | null;
}

// ─── Delivery Person (Rider) ───

export interface DeliveryPerson {
  id: string;
  name: string | null;
  phone: string | null;
  avatar_url: string | null;
  current_latitude: number | null;
  current_longitude: number | null;
  rating: number | null;
  vehicle_type: string | null;
}

// ─── Status History Entry ───

export interface StatusHistoryEntry {
  status: string;
  inserted_at: string;
}

// ─── Seller Order (from serialize_order/1) ───

export interface SellerOrder {
  id: string;
  order_number: string;
  callout_number: number | null;
  order_type: string | null;
  is_pos: boolean;
  customer_name: string | null;
  customer_phone: string | null;
  pos_payment_method: string | null;
  paid_at: string | null;
  status: string;
  delivery_id: string | null;
  delivery_status: string | null;
  is_paid: boolean;
  payment: OrderPayment;
  payment_mode: string;
  total_minor: number;
  subtotal_minor: number;
  delivery_fee_minor: number;
  tax_minor: number;
  tip_minor: number | null;
  discount_minor: number;
  promo_code: string | null;
  tax_lines: OrderTaxLine[];
  currency: string;
  currency_code: string;
  business_id: string;
  business: OrderBusiness | null;
  delivery_address: OrderDeliveryAddress | null;
  delivery_lat: number | null;
  delivery_lng: number | null;
  user: OrderUser | null;
  items: OrderItem[];
  inserted_at: string;
}

// ─── Detail extras (from serialize_order_detail/1) ───

export interface SellerOrderDetail extends SellerOrder {
  notes: string | null;
  delivery_person: DeliveryPerson | null;
  delivery_id: string | null;
  delivery_status: string | null;
  merchant_handover_confirmed_at: string | null;
  rider_pickup_confirmed_at: string | null;
  eta_minutes: number | null;
  status_history: StatusHistoryEntry[];
  business: OrderBusiness | null;
  items: OrderItem[];
}

// ─── API Response Types ───

export type SellerOrdersResponse = PaginatedResponse<SellerOrder>;

export interface SellerOrderDetailResponse {
  data: SellerOrderDetail;
}

// ─── Delivery Item (from serialize_delivery/1) ───

export interface DeliveryOrderItem {
  id: string;
  menu_item: OrderMenuItem | null;
  quantity: number;
  unit_price: number;
  subtotal: number;
}

export interface DeliveryRider {
  id: string;
  rider_number: string | null;
  name: string | null;
  phone: string | null;
  avatar_url: string | null;
}

export interface BusinessDelivery {
  id: string;
  status: string;
  rider_pickup_confirmed_at: string | null;
  merchant_handover_confirmed_at: string | null;
  inserted_at: string;
  order: {
    id: string;
    order_number: string;
    status: string;
    customer_name: string | null;
    customer_phone: string | null;
    total_minor: number;
    subtotal_minor: number;
    delivery_fee_minor: number;
    currency: string;
    delivery_address: OrderDeliveryAddress | null;
    user: OrderUser | null;
    items: DeliveryOrderItem[];
  } | null;
  rider: DeliveryRider | null;
}

export type BusinessDeliveriesResponse = PaginatedResponse<BusinessDelivery>;
