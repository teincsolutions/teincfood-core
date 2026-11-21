// ─── Business ───

export interface Business {
  id: string;
  name: string;
  description: string;
  type: string;
  phone: string;
  email: string;
  status: string;
  /** Role of the signed-in user in this business (owner/member/cashier/...). */
  role?: string;
  /** Where the relationship comes from: owner | member | super_admin. */
  source?: string;
  currency: string;
  is_open: boolean;
  /** Seller-facing open/close toggle (present when backend serializes it). */
  manually_closed?: boolean;
  /**
   * Fulfilment flow for orders taken on a terminal / in the business app.
   * "staged" (default) = accept → preparing → ready → completed;
   * "direct" = completed the moment the sale is rung up.
   * Buyer-placed online orders always keep the staged pipeline.
   */
  pos_order_flow?: "staged" | "direct";
  owner_id: string;
  business_number: string;
  latitude: number;
  longitude: number;
  logo_url: string | null;
  cover_image_url: string | null;
  kyc_status: string;
  rating: number | null;
  address?: { street: string; city: string; region?: string; country?: string; latitude?: number; longitude?: number } | null;
  inserted_at: string;
  updated_at: string;
}

export interface BusinessResponse {
  data: Business;
}

export interface BusinessListResponse {
  data: Business[];
}

// ─── Business Membership (from /businesses/me/memberships) ───

export interface BusinessMembershipBusiness {
  id: string;
  business_number: string;
  name: string;
  type: string;
  status: string;
  logo_url: string | null;
  cover_image_url: string | null;
}

export interface BusinessMembership {
  business: BusinessMembershipBusiness;
  role: string;
  status: string;
  source: string | null;
  invited_by_user_id: string | null;
}

export interface BusinessMembershipListResponse {
  data: BusinessMembership[];
}

// ─── My Business Membership (from /businesses/:business_id/my-membership) ───

export interface BusinessMembershipDetail {
  business_id: string;
  role: string;
  source: string;
  status: string;
  capabilities: string[];
}

export interface BusinessMembershipResponse {
  data: BusinessMembershipDetail;
}

// ─── Business Member ───

export interface BusinessMember {
  id: string;
  user_id: string;
  role: string;
  status: string;
  inserted_at: string;
  user?: {
    id: string;
    email: string | null;
    full_name: string | null;
  } | null;
  full_name?: string | null;
  email?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
  capabilities?: string[];
}

export interface BusinessMemberListResponse {
  data: BusinessMember[];
}

export interface BusinessMemberDetail extends BusinessMember {
  user?: {
    id: string;
    email: string | null;
    full_name: string | null;
  } | null;
  updated_at?: string;
}

export interface BusinessMemberDetailResponse {
  data: BusinessMemberDetail;
}

// ─── Operating Hours ───

export interface OperatingHoursEntry {
  id?: string;
  day_of_week: number; // 0=Monday, 6=Sunday
  open_time: string | null;
  close_time: string | null;
  is_closed: boolean;
}

export interface OperatingHoursResponse {
  data: OperatingHoursEntry[];
}

export interface DayHours {
  open: string;
  close: string;
}

// ─── Promo ───

export interface Promo {
  id: string;
  code: string;
  discount_percent: number | null;
  discount_minor: number | null;
  max_uses: number | null;
  used_count: number;
  expires_at: string | null;
  is_active: boolean;
  business_id: string;
}

export interface PromoListResponse {
  data: Promo[];
}

export interface PromoResponse {
  data: Promo;
}

// ─── Tax Rule ───

export interface TaxRule {
  id: string;
  business_id: string;
  name: string;
  code: string;
  country_code: string;
  rate_basis_points: number;
  applies_to: 'subtotal' | 'subtotal_plus_delivery';
  is_inclusive: boolean;
  is_active: boolean;
  display_order: number;
  inserted_at: string;
  updated_at: string;
}

export interface TaxRuleListResponse {
  data: TaxRule[];
}

export interface TaxRuleResponse {
  data: TaxRule;
}

export interface TaxRuleRequest {
  tax_rule: {
    name: string;
    code: string;
    country_code: string;
    rate_basis_points: number;
    applies_to: 'subtotal' | 'subtotal_plus_delivery';
    is_inclusive: boolean;
    is_active: boolean;
    display_order?: number;
  };
}

// ─── Member invitations (matches backend invitation payloads) ───

export interface BusinessMemberInvitation {
  id: string;
  business_id: string;
  invited_email: string;
  role: string;
  status: string;
  expires_at: string;
  inserted_at: string;
  invited_by?: { id: string; full_name: string; email: string } | null;
}

export interface BusinessMemberInvitationListResponse {
  data: BusinessMemberInvitation[];
}

export interface UserInvitation {
  id: string;
  type: 'business_owner' | 'fleet_rider' | 'business_member' | 'rider_linked';
  status: string;
  business_name: string | null;
  business_id: string | null;
  code: string | null;
  role?: string;
  is_fleet_managed: boolean;
  created_at: string | null;
}

// ─── Roles (matches backend roles payload) ───

export interface RoleCapabilityItem {
  key: string;
  label: string;
  description?: string;
}

export interface RoleCapability {
  label: string;
  capabilities: RoleCapabilityItem[];
}

export interface RolesResponse {
  data: Record<string, RoleCapability>;
}
