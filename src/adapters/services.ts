/**
 * Service stubs for pos/seller/kiosk/menu/business/roles.
 * Host apps can replace via setServiceImpls; core defaults to no-op that throws helpful error.
 */

function notImpl(name: string): never {
  throw new Error(`Service ${name} not injected. Wire via adapters/services.ts or setHttpClient.`);
}

import type { SellerOrdersResponse, SellerOrderDetailResponse, BusinessDeliveriesResponse } from "../types/api/seller.api";

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
  assignKioskOrderToRider: async (_orderId: string, _riderId: string): Promise<unknown> => {
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
  fetchBusinessTaxRules: async (_businessId: string): Promise<unknown> => {
    notImpl("businessService.fetchBusinessTaxRules");
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
