/**
 * Service stubs for pos/seller/kiosk/menu/business/roles.
 * Host apps can replace via setServiceImpls; core defaults to no-op that throws helpful error.
 */

function notImpl(name: string): never {
  throw new Error(`Service ${name} not injected. Wire via adapters/services.ts or setHttpClient.`);
}

// pos.service
export const posService = {
  createPOSOrder: async (_businessId: string, _payload: unknown): Promise<{ data: unknown }> => {
    notImpl("posService.createPOSOrder");
  },
  fetchPOSOrderPreview: async (_businessId: string, _payload: unknown): Promise<unknown> => {
    notImpl("posService.fetchPOSOrderPreview");
  },
  fetchBusinessOrders: async (_businessId: string, _params?: unknown): Promise<unknown> => {
    notImpl("posService.fetchBusinessOrders");
  },
};

// seller.service
export const sellerService = {
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
};

// kiosk.service
export const kioskService = {
  assignKioskOrderToRider: async (_orderId: string, _riderId: string): Promise<unknown> => {
    notImpl("kioskService.assignKioskOrderToRider");
  },
};

// menu.service etc. for reference fallback
export const menuService = {
  fetchBusinessMenuItems: async (_businessId: string, _page: number): Promise<unknown> => {
    notImpl("menuService.fetchBusinessMenuItems");
  },
  fetchBusinessCategories: async (_businessId: string): Promise<unknown> => {
    notImpl("menuService.fetchBusinessCategories");
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
