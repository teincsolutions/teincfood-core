/**
 * Service stubs for pos/seller/kiosk/menu/business/roles.
 * Host apps can replace via setServiceImpls; core defaults to no-op that throws helpful error.
 */

function notImpl(name: string): never {
  throw new Error(`Service ${name} not injected. Wire via adapters/services.ts or setHttpClient.`);
}

import type { SellerOrdersResponse, SellerOrderDetailResponse, BusinessDeliveriesResponse } from "../types/api/seller.api";
import type { PlaceSuggestion, PlaceDetails } from "../types/places";

// pos.service — NOTE: no createPOSOrder slot. Order creation has exactly one
// path: createLocalOrder (domain/orders/service). Direct-REST creation was
// removed so the operating-hours gate can never be bypassed.
export const posService = {
  fetchPOSOrderPreview: async (_businessId: string, _payload: unknown): Promise<unknown> => {
    notImpl("posService.fetchPOSOrderPreview");
  },
  fetchBusinessOrders: async (_businessId: string, _params?: Record<string, string>): Promise<SellerOrdersResponse> => {
    notImpl("posService.fetchBusinessOrders");
  },
};

// seller.service — also order listing used by POS/seller order lifecycle
export const sellerService = {
  fetchBusinessOrders: async (_businessId: string, _params?: Record<string, unknown>): Promise<SellerOrdersResponse> => {
    notImpl("sellerService.fetchBusinessOrders");
  },
  fetchSellerOrder: async (_orderId: string): Promise<SellerOrderDetailResponse> => {
    notImpl("sellerService.fetchSellerOrder");
  },
  fetchBusinessDeliveries: async (_businessId: string, _params?: Record<string, unknown>): Promise<BusinessDeliveriesResponse> => {
    notImpl("sellerService.fetchBusinessDeliveries");
  },
  acceptOrder: async (_orderId: string): Promise<{ data: unknown }> => {
    notImpl("sellerService.acceptOrder");
  },
  rejectOrder: async (_orderId: string): Promise<{ data: unknown }> => {
    notImpl("sellerService.rejectOrder");
  },
  startPreparingOrder: async (_orderId: string): Promise<{ data: unknown }> => {
    notImpl("sellerService.startPreparingOrder");
  },
  markOrderReady: async (_orderId: string): Promise<{ data: unknown }> => {
    notImpl("sellerService.markOrderReady");
  },
  completeOrderPickup: async (_orderId: string): Promise<{ data: unknown }> => {
    notImpl("sellerService.completeOrderPickup");
  },
  cancelOrder: async (_orderId: string): Promise<{ data: unknown }> => {
    notImpl("sellerService.cancelOrder");
  },
  confirmHandover: async (_deliveryId: string): Promise<unknown> => {
    notImpl("sellerService.confirmHandover");
  },
  confirmCashPayment: async (_orderId: string): Promise<{ data: unknown }> => {
    notImpl("sellerService.confirmCashPayment");
  },
};

// kiosk.service
export const kioskService = {
  assignKioskOrderToRider: async (
    _orderId: string,
    _riderId: string,
    _idempotencyKey?: string,
  ): Promise<unknown> => {
    notImpl("kioskService.assignKioskOrderToRider");
  },
};

// menu.service etc. for reference fallback + command dispatch
export const menuService = {
  fetchBusinessMenuItems: async (_businessId: string, _page: number): Promise<unknown> => {
    notImpl("menuService.fetchBusinessMenuItems");
  },
  fetchBusinessCategories: async (_businessId: string): Promise<unknown> => {
    notImpl("menuService.fetchBusinessCategories");
  },
  createMenuItem: async (_businessId: string, _payload: Record<string, unknown>): Promise<unknown> => {
    notImpl("menuService.createMenuItem");
  },
  updateMenuItem: async (_itemId: string, _payload: Record<string, unknown>): Promise<unknown> => {
    notImpl("menuService.updateMenuItem");
  },
  deleteMenuItem: async (_itemId: string): Promise<unknown> => {
    notImpl("menuService.deleteMenuItem");
  },
  createCategory: async (_businessId: string, _payload: Record<string, unknown>): Promise<unknown> => {
    notImpl("menuService.createCategory");
  },
  updateCategory: async (_categoryId: string, _payload: Record<string, unknown>): Promise<unknown> => {
    notImpl("menuService.updateCategory");
  },
  deleteCategory: async (_categoryId: string): Promise<unknown> => {
    notImpl("menuService.deleteCategory");
  },
};

export const businessService = {
  fetchBusinessMembers: async (_businessId: string): Promise<unknown> => {
    notImpl("businessService.fetchBusinessMembers");
  },
  fetchBusinessMember: async (_businessId: string, _userId: string): Promise<unknown> => {
    notImpl("businessService.fetchBusinessMember");
  },
  inviteBusinessMember: async (_businessId: string, _data: Record<string, unknown>): Promise<unknown> => {
    notImpl("businessService.inviteBusinessMember");
  },
  updateBusinessMember: async (
    _businessId: string,
    _userId: string,
    _data: Record<string, unknown>,
  ): Promise<unknown> => {
    notImpl("businessService.updateBusinessMember");
  },
  removeBusinessMember: async (_businessId: string, _userId: string): Promise<unknown> => {
    notImpl("businessService.removeBusinessMember");
  },
  fetchBusinessMemberInvitations: async (_businessId: string): Promise<unknown> => {
    notImpl("businessService.fetchBusinessMemberInvitations");
  },
  revokeBusinessMemberInvitation: async (_businessId: string, _invitationId: string): Promise<unknown> => {
    notImpl("businessService.revokeBusinessMemberInvitation");
  },
  deleteBusinessMemberInvitation: async (_businessId: string, _invitationId: string): Promise<unknown> => {
    notImpl("businessService.deleteBusinessMemberInvitation");
  },
  fetchUserInvitations: async (): Promise<unknown> => {
    notImpl("businessService.fetchUserInvitations");
  },
  leaveBusiness: async (_invitationId: string): Promise<unknown> => {
    notImpl("businessService.leaveBusiness");
  },
  acceptBusinessInvitation: async (_data: Record<string, unknown>): Promise<unknown> => {
    notImpl("businessService.acceptBusinessInvitation");
  },
  fetchBusinessTaxRules: async (_businessId: string): Promise<unknown> => {
    notImpl("businessService.fetchBusinessTaxRules");
  },
  createBusinessTaxRule: async (_businessId: string, _data: Record<string, unknown>): Promise<unknown> => {
    notImpl("businessService.createBusinessTaxRule");
  },
  updateTaxRule: async (_id: string, _data: Record<string, unknown>): Promise<unknown> => {
    notImpl("businessService.updateTaxRule");
  },
  deleteTaxRule: async (_id: string): Promise<unknown> => {
    notImpl("businessService.deleteTaxRule");
  },
  fetchBusinessById: async (_businessId: string): Promise<unknown> => {
    notImpl("businessService.fetchBusinessById");
  },
  fetchOperatingHours: async (_businessId: string): Promise<unknown> => {
    notImpl("businessService.fetchOperatingHours");
  },
  fetchMyBusinessMembership: async (_businessId: string): Promise<unknown> => {
    notImpl("businessService.fetchMyBusinessMembership");
  },
};

export const rolesService = {
  fetchBusinessRoles: async (): Promise<unknown> => {
    notImpl("rolesService.fetchBusinessRoles");
  },
};

// wallet.service — balances + history (hosts inject axios impls)
export const walletService = {
  fetchAllBalances: async (): Promise<unknown> => {
    notImpl("walletService.fetchAllBalances");
  },
  fetchBusinessWalletBalance: async (_businessId: string): Promise<unknown> => {
    notImpl("walletService.fetchBusinessWalletBalance");
  },
  fetchWalletHistory: async (_params: { businessId?: string; page?: number; pageSize?: number }): Promise<unknown> => {
    notImpl("walletService.fetchWalletHistory");
  },
};

// delivery.service — business deliveries (hosts inject axios impls)
export const deliveryService = {
  fetchBusinessDeliveries: async (_businessId: string, _params?: Record<string, unknown>): Promise<unknown> => {
    notImpl("deliveryService.fetchBusinessDeliveries");
  },
  fetchDeliveryDetail: async (_deliveryId: string): Promise<unknown> => {
    notImpl("deliveryService.fetchDeliveryDetail");
  },
};

// dashboard.service — seller dashboard (hosts inject axios impls)
export const dashboardService = {
  fetchSellerDashboard: async (_businessId: string): Promise<unknown> => {
    notImpl("dashboardService.fetchSellerDashboard");
  },
};

// analytics.service — seller analytics + revenue (hosts inject axios impls)
export const analyticsService = {
  fetchSellerAnalytics: async (
    _businessId: string,
    _period?: string,
    _range?: { date_from?: string; date_to?: string },
  ): Promise<unknown> => {
    notImpl("analyticsService.fetchSellerAnalytics");
  },
  fetchRevenueSummary: async (
    _businessId: string,
    _period?: string,
    _range?: { date_from?: string; date_to?: string },
  ): Promise<unknown> => {
    notImpl("analyticsService.fetchRevenueSummary");
  },
};

// places.service — place autocomplete/details (hosts inject axios impls)
export const placesService = {
  searchPlaces: async (_query: string, _lat?: number, _lng?: number): Promise<PlaceSuggestion[]> => {
    notImpl("placesService.searchPlaces");
    return [];
  },
  getPlaceDetails: async (_placeId: string): Promise<PlaceDetails | null> => {
    notImpl("placesService.getPlaceDetails");
    return null;
  },
  clearCache: async (): Promise<void> => {
    notImpl("placesService.clearCache");
  },
};

// fleet.service — fleet management (hosts inject axios impls)
export const fleetService = {
  fetchFleetRiders: async (_businessId?: string, _page?: number, _pageSize?: number, _filters?: unknown): Promise<unknown> => {
    notImpl("fleetService.fetchFleetRiders");
  },
  fetchFleetRider: async (_riderId: string, _businessId?: string): Promise<unknown> => {
    notImpl("fleetService.fetchFleetRider");
  },
  inviteRider: async (_data: Record<string, unknown>, _businessId?: string): Promise<unknown> => {
    notImpl("fleetService.inviteRider");
  },
  approveRider: async (_riderId: string, _businessId?: string): Promise<unknown> => {
    notImpl("fleetService.approveRider");
  },
  suspendRider: async (_riderId: string, _businessId?: string): Promise<unknown> => {
    notImpl("fleetService.suspendRider");
  },
  activateRider: async (_riderId: string, _businessId?: string): Promise<unknown> => {
    notImpl("fleetService.activateRider");
  },
  fetchRiderKyc: async (_riderId: string, _businessId?: string): Promise<unknown> => {
    notImpl("fleetService.fetchRiderKyc");
  },
  fetchJoinRequests: async (_businessId?: string): Promise<unknown> => {
    notImpl("fleetService.fetchJoinRequests");
  },
  approveJoinRequest: async (_requestId: string, _businessId?: string): Promise<unknown> => {
    notImpl("fleetService.approveJoinRequest");
  },
  rejectJoinRequest: async (_requestId: string, _businessId?: string): Promise<unknown> => {
    notImpl("fleetService.rejectJoinRequest");
  },
  fetchInvitations: async (_businessId?: string): Promise<unknown> => {
    notImpl("fleetService.fetchInvitations");
  },
  revokeInvitation: async (_invitationId: string, _businessId?: string): Promise<unknown> => {
    notImpl("fleetService.revokeInvitation");
  },
  fetchFleetVehicles: async (_businessId?: string): Promise<unknown> => {
    notImpl("fleetService.fetchFleetVehicles");
  },
  addVehicle: async (_data: Record<string, unknown>, _businessId?: string): Promise<unknown> => {
    notImpl("fleetService.addVehicle");
  },
  removeVehicle: async (_vehicleId: string, _businessId?: string): Promise<unknown> => {
    notImpl("fleetService.removeVehicle");
  },
  fetchFleetDashboard: async (_businessId?: string): Promise<unknown> => {
    notImpl("fleetService.fetchFleetDashboard");
  },
};
export const riderService = {
  fetchRiderProfile: async (): Promise<unknown> => {
    notImpl("riderService.fetchRiderProfile");
  },
  updateRiderProfile: async (_data: Record<string, unknown>): Promise<unknown> => {
    notImpl("riderService.updateRiderProfile");
  },
  updateOnlineStatus: async (_isOnline: boolean): Promise<unknown> => {
    notImpl("riderService.updateOnlineStatus");
  },
  fetchRiderMetrics: async (): Promise<unknown> => {
    notImpl("riderService.fetchRiderMetrics");
  },
  fetchRiderDashboard: async (): Promise<unknown> => {
    notImpl("riderService.fetchRiderDashboard");
  },
  fetchRiderStatistics: async (): Promise<unknown> => {
    notImpl("riderService.fetchRiderStatistics");
  },
  fetchAvailableOrders: async (): Promise<unknown> => {
    notImpl("riderService.fetchAvailableOrders");
  },
  acceptDelivery: async (_orderId: string): Promise<unknown> => {
    notImpl("riderService.acceptDelivery");
  },
  selfAssignDelivery: async (_orderId: string): Promise<unknown> => {
    notImpl("riderService.selfAssignDelivery");
  },
  fetchActiveDelivery: async (): Promise<unknown> => {
    notImpl("riderService.fetchActiveDelivery");
  },
  fetchRiderDeliveries: async (_page: number, _pageSize: number, _filters?: Record<string, unknown>): Promise<unknown> => {
    notImpl("riderService.fetchRiderDeliveries");
  },
  fetchDeliveryDetail: async (_deliveryId: string): Promise<unknown> => {
    notImpl("riderService.fetchDeliveryDetail");
  },
  markDeliveryInTransit: async (_deliveryId: string): Promise<unknown> => {
    notImpl("riderService.markDeliveryInTransit");
  },
  markDeliveryArrived: async (_deliveryId: string): Promise<unknown> => {
    notImpl("riderService.markDeliveryArrived");
  },
  markDeliveryDelivered: async (_deliveryId: string): Promise<unknown> => {
    notImpl("riderService.markDeliveryDelivered");
  },
  markDeliveryFailed: async (_deliveryId: string): Promise<unknown> => {
    notImpl("riderService.markDeliveryFailed");
  },
  markDeliveryReturned: async (_deliveryId: string): Promise<unknown> => {
    notImpl("riderService.markDeliveryReturned");
  },
  confirmDeliveryPickup: async (_deliveryId: string): Promise<unknown> => {
    notImpl("riderService.confirmDeliveryPickup");
  },
  confirmDeliveryHandover: async (_deliveryId: string): Promise<unknown> => {
    notImpl("riderService.confirmDeliveryHandover");
  },
  fetchRiderEarnings: async (): Promise<unknown> => {
    notImpl("riderService.fetchRiderEarnings");
  },
  fetchEarningsBreakdown: async (): Promise<unknown> => {
    notImpl("riderService.fetchEarningsBreakdown");
  },
  fetchRiderEarningsSummary: async (_period: string): Promise<unknown> => {
    notImpl("riderService.fetchRiderEarningsSummary");
  },
  fetchWalletHistory: async (_page?: number, _pageSize?: number): Promise<unknown> => {
    notImpl("riderService.fetchWalletHistory");
  },
  fetchVehicleInfo: async (): Promise<unknown> => {
    notImpl("riderService.fetchVehicleInfo");
  },
  createVehicle: async (_data: unknown): Promise<unknown> => {
    notImpl("riderService.createVehicle");
  },
  fetchDeliveryZones: async (): Promise<unknown> => {
    notImpl("riderService.fetchDeliveryZones");
  },
  updateDeliveryZones: async (_zones: unknown): Promise<unknown> => {
    notImpl("riderService.updateDeliveryZones");
  },
  toggleDeliveryZone: async (_zoneId: string, _enabled: boolean): Promise<unknown> => {
    notImpl("riderService.toggleDeliveryZone");
  },
  fetchNavigationSettings: async (): Promise<unknown> => {
    notImpl("riderService.fetchNavigationSettings");
  },
  updateNavigationSettings: async (_settings: unknown): Promise<unknown> => {
    notImpl("riderService.updateNavigationSettings");
  },
  fetchNavigationApps: async (): Promise<unknown> => {
    notImpl("riderService.fetchNavigationApps");
  },
  fetchVehicleTypes: async (): Promise<unknown> => {
    notImpl("riderService.fetchVehicleTypes");
  },
};

// region pricing + location stubs for currency utils
export function getRegionConfig(_countryCode?: string): { currencyCode: string } {
  return { currencyCode: "GHS" };
}
export function formatCurrencyByRegion(amountMinor: number, _config: unknown): string {
  return `GH₵${(amountMinor / 100).toFixed(2)}`;
}

export const useLocationStore = {
  getState: () => ({ currentLocation: null as { countryCode?: string } | null }),
  // hook form: selector
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  subscribe: (_fn: unknown) => () => {},
} as unknown as {
  getState(): { currentLocation: { countryCode?: string } | null };
  (selector: (s: { currentLocation: unknown }) => unknown): unknown;
};
