/**
 * Currency Utility — no RN/store dependencies.
 */

export const DEFAULT_CURRENCY = "GHS";

const CURRENCY_SYMBOLS: Record<string, string> = {
  GHS: "GH₵",
  USD: "$",
  NGN: "₦",
  KES: "KSh",
  EUR: "€",
  GBP: "£",
};

export function getCurrencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] || currency;
}

export function formatPrice(amount: number, currency: string = DEFAULT_CURRENCY): string {
  return `${getCurrencySymbol(currency)}${amount.toFixed(2)}`;
}

export function formatPriceFromMinor(amountMinor: number, currency: string = DEFAULT_CURRENCY): string {
  const amount = amountMinor / 100;
  return formatPrice(amount, currency);
}

// Compatibility hooks — return default when no location adapter injected
export function useCurrency(): string {
  return DEFAULT_CURRENCY;
}

export function useCurrencySymbol(): string {
  return getCurrencySymbol(DEFAULT_CURRENCY);
}
