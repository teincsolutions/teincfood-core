/**
 * POS cart store — device-local, persisted via KV driver.
 * Mirrors TeincFoodBusiness/src/stores/pos.store.ts
 * Persist key: "Teinc Food-pos-cart" (for migration compatibility).
 */

import { getKVDriver } from "../adapters/kv";
import { accountScopedKey, getAccountScope, subscribeAccountScope } from "../session/account-scope";
import type { MenuItem, MenuItemVariantResponse, MenuItemAddonResponse } from "../types/api/menu.api";
import type { POSCartItem, POSCheckoutForm, POSSelectedAddon } from "../types/pos.types";

const CART_KEY = "Teinc Food-pos-cart";
/** Null until an account is active; never persist a cart device-wide. */
function cartStorageKey(): string | null {
  return getAccountScope() ? accountScopedKey(CART_KEY) : null;
}

export interface CartState {
  items: POSCartItem[];
  checkoutForm: POSCheckoutForm;
}

const defaultCheckoutForm: POSCheckoutForm = {
  customer_name: "",
  customer_phone: "",
  order_type: "takeout",
  pos_payment_method: "cash",
};

let state: CartState = {
  items: [],
  checkoutForm: { ...defaultCheckoutForm },
};

let hydrated = false;
const listeners = new Set<() => void>();
function notify() { listeners.forEach((l) => l()); }

async function persist() {
  try {
    const key = cartStorageKey();
    if (!key) return;
    const kv = getKVDriver();
    await kv.setItem(key, JSON.stringify({ state: { items: state.items, checkoutForm: state.checkoutForm }, version: 0 }));
  } catch {}
}

export async function hydrateCartStore(): Promise<void> {
  if (hydrated) return;
  // A cart belongs to the signed-in account. Never hydrate the unscoped
  // legacy key before login: that is exactly how one user's basket leaks
  // into the next account's POS.
  const key = cartStorageKey();
  if (!key) {
    state = { items: [], checkoutForm: { ...defaultCheckoutForm } };
    notify();
    return;
  }
  hydrated = true;
  try {
    const kv = getKVDriver();
    const raw = await kv.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: Partial<CartState> };
      const s = parsed.state ?? parsed as Partial<CartState>;
      state = {
        items: Array.isArray(s.items) ? s.items : [],
        checkoutForm: s.checkoutForm ? { ...defaultCheckoutForm, ...s.checkoutForm } : { ...defaultCheckoutForm },
      };
      notify();
    }
  } catch {}
}

/** Re-read after the host injects its persistent KV driver at bootstrap. */
export function resetCartHydration(): void {
  hydrated = false;
}

export function getCartState(): CartState { return state; }
export function subscribeCart(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getCartSnapshot(): CartState { return state; }

function computeUnitPrice(
  menuItem: MenuItem,
  variant: MenuItemVariantResponse | null,
  addons: MenuItemAddonResponse[],
): number {
  let price = (menuItem as unknown as { basePrice?: { amountMinor?: number }; base_price?: { amount_minor?: number } })?.basePrice?.amountMinor
    ?? (menuItem as unknown as { base_price?: { amount_minor?: number } })?.base_price?.amount_minor
    ?? 0;
  if (variant) price = (variant as unknown as { price?: { amountMinor?: number }; amountMinor?: number; priceMinor?: number }).price?.amountMinor ?? (variant as unknown as { price_minor?: number }).price_minor ?? price;
  // addons: amountMinor
  for (const a of addons) {
    const amt = (a as unknown as { amountMinor?: number; amount_minor?: number }).amountMinor ?? (a as unknown as { amount_minor?: number }).amount_minor ?? 0;
    price += amt;
  }
  return price;
}

function makeCartItemId(menuItemId: string, variantId: string | undefined, addonIds: string[]): string {
  const sorted = [...addonIds].sort();
  return `${menuItemId}-${variantId || ""}-${sorted.join(",")}`;
}

export function addItem(
  menuItem: MenuItem,
  quantity: number,
  variant: MenuItemVariantResponse | null,
  addons: MenuItemAddonResponse[],
): void {
  const variantId = variant?.id;
  const addonIds = addons.map((a) => a.id);
  const cartItemId = makeCartItemId(menuItem.id, variantId, addonIds);
  const unitPrice = computeUnitPrice(menuItem, variant, addons);
  const selectedAddons: POSSelectedAddon[] = addons.map((a) => ({
    addon_id: a.id,
    name: a.name,
    price_minor: (a as unknown as { amountMinor?: number; amount_minor?: number }).amountMinor ?? (a as unknown as { amount_minor?: number }).amount_minor ?? 0,
  }));
  const existing = state.items.find((i) => i.id === cartItemId);
  if (existing) {
    state = { ...state, items: state.items.map((i) => i.id === cartItemId ? { ...i, quantity: i.quantity + quantity } : i) };
  } else {
    const item: POSCartItem = {
      id: cartItemId,
      menu_item: menuItem,
      quantity,
      selected_variant: variant,
      selected_addons: selectedAddons,
      notes: "",
      unit_price_minor: unitPrice,
    };
    state = { ...state, items: [...state.items, item] };
  }
  notify(); void persist();
}

export function removeItem(cartItemId: string): void {
  state = { ...state, items: state.items.filter((i) => i.id !== cartItemId) };
  notify(); void persist();
}

export function updateQuantity(cartItemId: string, quantity: number): void {
  state = { ...state, items: state.items.map((i) => i.id === cartItemId ? { ...i, quantity: Math.max(1, quantity) } : i) };
  notify(); void persist();
}

export function updateCheckoutForm(updates: Partial<POSCheckoutForm>): void {
  state = { ...state, checkoutForm: { ...state.checkoutForm, ...updates } };
  notify(); void persist();
}

export function clearCart(): void { state = { ...state, items: [] }; notify(); void persist(); }
export function clearAll(): void { state = { items: [], checkoutForm: { ...defaultCheckoutForm } }; notify(); void persist(); }

// Account switch: drop the previous user's in-memory cart immediately and
// hydrate the new account's scoped cart. Never persist the old basket into the
// new account's key.
subscribeAccountScope(() => {
  state = { items: [], checkoutForm: { ...defaultCheckoutForm } };
  hydrated = false;
  notify();
  void hydrateCartStore();
});

export const cartStore = {
  getState: getCartState,
  subscribe: subscribeCart,
  getSnapshot: getCartSnapshot,
  hydrate: hydrateCartStore,
  addItem, removeItem, updateQuantity, updateCheckoutForm, clearCart, clearAll,
};
