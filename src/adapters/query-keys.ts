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
};

export const MENU_KEYS = {
  all: ["menu"] as const,
};

export const REFERENCE_KEYS = {
  all: ["reference"] as const,
};
