/**
 * Query key stubs for reconciliation bridge.
 * Real host apps expose these; core only needs shape for invalidateQueries.
 */

export const POS_KEYS = {
  all: ["pos"] as const,
  orders: (businessId: string) => ["pos", "orders", businessId] as const,
};

export const SELLER_KEYS = {
  all: ["seller"] as const,
  orders: (businessId?: string) => ["seller", "orders", businessId].filter((x) => x !== undefined) as readonly unknown[],
};

export const KIOSK_KEYS = {
  all: ["kiosk"] as const,
};

export const SELLER_ORDERS_KEYS = {
  all: ["seller-orders"] as const,
};

export const BUSINESS_DELIVERIES_KEYS = {
  all: ["business-deliveries"] as const,
};

export const MENU_KEYS = {
  all: ["menu"] as const,
};

export const REFERENCE_KEYS = {
  all: ["reference"] as const,
};

export const SELLER_DASHBOARD_KEYS = {
  all: ["seller-dashboard"] as const,
  full: (businessId?: string) => ["seller-dashboard", "full", businessId].filter((x) => x !== undefined) as readonly unknown[],
};
