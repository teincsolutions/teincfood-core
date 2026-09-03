/**
 * Cart hooks — UI bindings for the device-local cart store + pricing.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getCartSnapshot, subscribeCart, hydrateCartStore, addItem, removeItem, updateQuantity, updateCheckoutForm, clearCart, clearAll } from "./store";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { usePOSOrderPreviewQuery } from "../hooks/orders.hooks";
import { calculatePricing } from "../pricing/engine";
import type { MenuItem, MenuItemVariantResponse, MenuItemAddonResponse } from "../types/api/menu.api";
import type { POSCheckoutForm } from "../types/pos.types";

export function usePOSStore() {
  const state = useSyncExternalStore(subscribeCart, getCartSnapshot, getCartSnapshot);
  useEffect(() => { void hydrateCartStore(); }, []);
  return {
    items: state.items,
    checkoutForm: state.checkoutForm,
    addItem: (menuItem: MenuItem, quantity: number, variant: MenuItemVariantResponse | null, addons: MenuItemAddonResponse[]) => addItem(menuItem, quantity, variant, addons),
    removeItem,
    updateQuantity,
    updateCheckoutForm: (u: Partial<POSCheckoutForm>) => updateCheckoutForm(u),
    clearCart,
    clearAll,
  };
}

export function usePOSCart() { return usePOSStore(); }

/**
 * Pricing hook — returns local calculation (always available offline) and
 * optional cloud preview; mirrors CheckoutPanel calculatePricing logic.
 */
export function usePOSPricing() {
  const cart = useSyncExternalStore(subscribeCart, getCartSnapshot, getCartSnapshot);
  const business = useSyncExternalStore(subscribeBusiness, () => (getActiveBusiness() as { id: string; currency_code?: string } | null), () => null as unknown as { id: string } | null);
  const currency = (business as unknown as { currency_code?: string } | null)?.currency_code ?? "GHS";

  // Need tax rules — pull from reference_data via lazy import to avoid cycle
  // For now, calculate without taxRules; host can pass taxRules if needed.
  const localPricing = useMemo(() => {
    try {
      return calculatePricing({ items: cart.items as unknown as Parameters<typeof calculatePricing>[0]["items"], taxRules: [] as unknown as Parameters<typeof calculatePricing>[0]["taxRules"], currency_code: currency });
    } catch { return null; }
  }, [cart.items, currency]);

  // Cloud preview still available via dedicated hook
  const preview = usePOSOrderPreviewQuery(cart.items as unknown as Parameters<typeof usePOSOrderPreviewQuery>[0], cart.checkoutForm.order_type, cart.checkoutForm.customer_name);

  return { cart, localPricing, preview, currency };
}
