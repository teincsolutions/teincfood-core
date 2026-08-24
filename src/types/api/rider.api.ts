import type { PaginationMeta, PaginatedResponse } from './pagination';

// ─── Rider Profile ───

export interface RiderProfileBusiness {
  id: string;
  name: string;
  business_number: string;
  type: string;
  status: string;
  logo_url: string | null;
  latitude: number | null;
  longitude: number | null;
  address: {
    address_line: string;
    city: string;
    region: string;
    latitude: number | null;
    longitude: number | null;
  } | null;
}

export interface RiderProfile {
  id: string;
  rider_number: string;
  user_id: string;
  status: string;
  is_online: boolean;
  is_fleet_managed: boolean;
  is_active: boolean;
  current_lat: number | null;
  current_lng: number | null;
  businesses: RiderProfileBusiness[];
  phone: string;
  license_number: string;
  kyc_status: string;
  vehicle_type: string | null;
  inserted_at: string;
  updated_at: string;
}

export interface RiderProfileResponse {
  data: RiderProfile;
}

// ─── Rider KYC ───

export interface RiderKycResponse {
  data: {
    kyc_status: string;
    documents?: string[];
  };
}

// ─── Rider Delivery ───

export interface RiderDelivery {
  id: string;
  order_id: string;
  order_number: string | null;
  status: string;
  pickup_name: string | null;
  pickup: string | null;
  dropoff: string | null;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_lat: number;
  dropoff_lng: number;
  eta_minutes: number;
  earnings_minor: number | null;
  currency: string | null;
  inserted_at: string;
  updated_at: string;
}

export type RiderDeliveriesResponse = PaginatedResponse<RiderDelivery>;

// ─── Rider Earnings ───

export interface RiderEarningsResponse {
  data: Record<string, unknown>[];
  pagination: PaginationMeta;
  total_earned_minor: number;
  currency: string;
}

// ─── Rider Earnings Summary ───

export interface RiderEarningsSummaryResponse {
  data: {
    total_earnings_minor: number;
    total_deliveries: number;
    currency: string;
    period: string;
  };
}

// ─── Rider Vehicle ───

export interface RiderVehicle {
  id: string;
  rider_id: string;
  plate_number: string;
  type: string;
  ownership: string;
  brand: string | null;
  model: string | null;
  color: string | null;
  year: number | null;
  inserted_at: string;
}

export interface RiderVehicleRequest {
  type: string;
  plate_number: string;
  brand: string;
  model: string;
  color: string;
  year?: number;
  ownership?: string;
}

export interface RiderVehicleResponse {
  data: RiderVehicle | null;
}

// ─── Available Orders (ready for claim) ───

export interface AvailableOrder {
  order_id: string;
  order_number: string;
  total_minor: number;
  currency: string;
  payment_mode: string;
  business_name: string;
  business_address: string | null;
  business_lat: number | null;
  business_lng: number | null;
  delivery_address: Record<string, unknown> | string | null;
  delivery_lat: number | null;
  delivery_lng: number | null;
  inserted_at: string;
}

export interface AvailableOrdersResponse {
  data: AvailableOrder[];
}

// ─── Rider Dashboard ───

export interface RiderDashboard {
  today_earnings_minor: number;
  today_deliveries: number;
  available_deliveries: number;
  total_deliveries: number;
  status: string;
}

export interface RiderDashboardResponse {
  data: RiderDashboard;
}

// ─── Rider Delivery Detail ───

export interface DeliveryCustomer {
  name: string | null;
  phone: string | null;
  user_id: string | null;
}

export interface DeliveryPickupLocation {
  name: string | null;
  address: string | null;
  phone: string | null;
  lat: number | null;
  lng: number | null;
}

export interface DeliveryDropoffLocation {
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  notes: string | null;
}

export interface DeliveryItem {
  name: string | null;
  quantity: number;
  price: number;
}

export interface RiderDeliveryDetail {
  id: string;
  order_id: string;
  order_number: string | null;
  status: string;
  pickup_lat: number | null;
  pickup_lng: number | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  eta_minutes: number | null;
  rider_pickup_confirmed_at: string | null;
  merchant_handover_confirmed_at: string | null;
  inserted_at: string;
  updated_at: string;
  customer: DeliveryCustomer;
  pickup: DeliveryPickupLocation;
  dropoff: DeliveryDropoffLocation;
  items: DeliveryItem[];
  order_total_minor: number | null;
  delivery_fee_minor: number | null;
  currency: string | null;
}

export interface RiderDeliveryDetailResponse {
  data: RiderDeliveryDetail;
}
