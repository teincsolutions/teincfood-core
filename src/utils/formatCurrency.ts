/**
 * Format a number as a currency string.
 */

export function formatCurrency(amount: number, currency: string = "GHS"): string {
  const amountMinor = Math.round(amount * 100);
  // Simple region formatting — host apps can inject getRegionConfig via adapter if needed
  const symbolMap: Record<string, string> = {
    GHS: "GH₵",
    USD: "$",
  };
  const symbol = symbolMap[currency] ?? currency;
  return `${symbol}${(amountMinor / 100).toFixed(2)}`;
}
