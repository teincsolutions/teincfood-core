// ─── Fleet Rider ───

export interface FleetRiderUser {
  id: string;
  full_name: string;
  phone?: string;
  avatar_url?: string;
}

export interface FleetRiderVehicle {
  id: string;
  type: string;
  plate_number: string;
  brand: string | null;
  model: string | null;
  color: string | null;
  year: number | null;
}

export interface FleetRider {
  id: string;
  rider_number: string;
  status: string;
  is_online: boolean;
  is_fleet_managed: boolean;
  is_active: boolean;
  phone: string;
  license_number: string;
  kyc_status: string;
  user: FleetRiderUser | null;
  vehicle: FleetRiderVehicle | null;
  inserted_at: string;
}

// ─── Fleet Rider Detail Response ───

export interface FleetRiderResponse {
  data: FleetRider;
}

// ─── Fleet Rider KYC ───

export interface FleetKycDocument {
  type: string;
  name: string;
  url: string | null;
  signed_url: string | null;
  document_id: string | null;
  issued_date: string | null;
  expiration_date: string | null;
  expired: boolean;
}

export interface FleetRiderKyc {
  rider_id: string;
  kyc_status: string;
  submitted_at: string | null;
  verified_at: string | null;
  documents: FleetKycDocument[];
}

export interface FleetRiderKycResponse {
  data: FleetRiderKyc;
}

// ─── Fleet Vehicle ───

export interface FleetVehicle {
  id: string;
  rider_id: string | null;
  plate_number: string;
  type: string;
  ownership: string;
  brand?: string;
  model?: string;
  color?: string;
  year?: number;
  rider_number?: string;
  rider_name?: string;
  inserted_at: string;
}

// ─── Responses ───

export interface FleetRidersResponse {
  data: FleetRider[];
}

export interface FleetVehiclesResponse {
  data: FleetVehicle[];
}

export interface JoinRequest {
  id: string;
  user_id: string;
  rider_number: string;
  status: string;
  inserted_at: string;
}

export interface FleetInvitation {
  id: string;
  business_id: string;
  status: string;
  inserted_at: string;
}

// ─── Fleet Dashboard ───

export interface FleetDashboard {
  total_riders: number;
  active_riders: number;
  online_riders: number;
  offline_riders: number;
  total_vehicles: number;
  today_deliveries: number;
  today_earnings_minor: number;
  pending_join_requests: number;
}

export interface FleetDashboardResponse {
  data: FleetDashboard;
}
