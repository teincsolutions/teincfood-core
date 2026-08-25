/**
 * Pricing engine — server-parity POS pricing.
 *
 * Pure port of the backend `calculate_items` / `calculate_tax_lines` /
 * `calculate_pricing` (TeincFoodBackend.Orders). Used as the instant local
 * preview and offline fallback so terminals agree on pricing even when the
 * cloud preview endpoint is unreachable. The cloud preview remains authoritative
 * when it lands; this engine reproduces the same math exactly.
 *
 * Tax semantics (matching backend):
 *  - inclusive taxes are EMBEDDED in the menu price → never added to the total,
 *    only shown in `tax_lines[].is_inclusive` for the breakdown.
 *  - exclusive taxes are ADDED on top of the (discounted) subtotal.
 *  - `tax_minor` is the sum of ALL lines (display breakdown); `total_minor`
 *    adds only `exclusive_tax_minor`.
 */

import type { POSCartItem } from "../types/pos.types";
import type { TaxRule } from "../types/api/business.api";
import type { OrderTaxLine } from "../types/api/seller.api";

export interface PricingInput {
  /** Cart items — `unit_price_minor` already includes variant + addons. */
  items: POSCartItem[];
  /** Active tax rules from cached reference data. */
  taxRules: TaxRule[];
  /** Optional promo discount in minor units. */
  discount_minor?: number;
  /** Delivery fee in minor units (POS is 0, but kept for parity). */
  delivery_fee_minor?: number;
  /** Tip in minor units. */
  tip_minor?: number;
  currency_code?: string;
}

export interface PricingResult {
  subtotal_minor: number;
  discounted_subtotal_minor: number;
  delivery_fee_minor: number;
  discount_minor: number;
  tax_minor: number;
  exclusive_tax_minor: number;
  tip_minor: number;
  total_minor: number;
  currency_code: string;
  tax_lines: OrderTaxLine[];
}

/** Backend parity: div((amount * rate + 5000), 10000) with integer math. */
export function calculateExclusiveTax(
  taxableAmountMinor: number,
  rateBasisPoints: number,
): number {
  if (taxableAmountMinor <= 0 || rateBasisPoints <= 0) return 0;
  return Math.floor(
    (taxableAmountMinor * rateBasisPoints + 5_000) / 10_000,
  );
}

/** Backend parity: inclusive tax share = div(amount*rate + 5000, 10000 + rate). */
export function calculateInclusiveTaxShare(
  taxableAmountMinor: number,
  rateBasisPoints: number,
): number {
  if (taxableAmountMinor <= 0 || rateBasisPoints <= 0) return 0;
  return Math.floor(
    (taxableAmountMinor * rateBasisPoints + 5_000) / (10_000 + rateBasisPoints),
  );
}

export function calculateTaxLines(
  subtotal_minor: number,
  taxRules: TaxRule[],
  discount_minor = 0,
  delivery_fee_minor = 0,
): { tax_lines: OrderTaxLine[]; tax_minor: number; exclusive_tax_minor: number } {
  const discounted = Math.max(subtotal_minor - discount_minor, 0);

  let tax_minor = 0;
  let exclusive_tax_minor = 0;
  const tax_lines: OrderTaxLine[] = taxRules.map((rule) => {
    const taxableAmount =
      rule.applies_to === "subtotal_plus_delivery"
        ? discounted + delivery_fee_minor
        : discounted;

    const taxAmount = rule.is_inclusive
      ? calculateInclusiveTaxShare(taxableAmount, rule.rate_basis_points)
      : calculateExclusiveTax(taxableAmount, rule.rate_basis_points);

    tax_minor += taxAmount;
    if (!rule.is_inclusive) exclusive_tax_minor += taxAmount;

    return {
      id: rule.id,
      business_tax_rule_id: rule.id,
      name: rule.name,
      code: rule.code,
      country_code: rule.country_code,
      rate_basis_points: rule.rate_basis_points,
      taxable_amount_minor: taxableAmount,
      tax_amount_minor: taxAmount,
      applies_to: rule.applies_to,
      is_inclusive: rule.is_inclusive,
    };
  });

  return { tax_lines, tax_minor, exclusive_tax_minor };
}

/**
 * Compute POS pricing mirrors backend `calculate_pos_pricing`:
 *   total = discounted_subtotal + exclusive_tax_minor (+ tip when provided).
 */
export function calculatePricing(input: PricingInput): PricingResult {
  const subtotal_minor = input.items.reduce(
    (sum, item) => sum + item.unit_price_minor * item.quantity,
    0,
  );
  const discount_minor = input.discount_minor ?? 0;
  const delivery_fee_minor = input.delivery_fee_minor ?? 0;
  const tip_minor = input.tip_minor ?? 0;
  const currency_code = input.currency_code ?? "GHS";

  const { tax_lines, tax_minor, exclusive_tax_minor } = calculateTaxLines(
    subtotal_minor,
    input.taxRules,
    discount_minor,
    delivery_fee_minor,
  );

  const discounted = Math.max(subtotal_minor - discount_minor, 0);

  return {
    subtotal_minor,
    discounted_subtotal_minor: discounted,
    delivery_fee_minor,
    discount_minor,
    tax_minor,
    exclusive_tax_minor,
    tip_minor,
    total_minor: discounted + delivery_fee_minor + exclusive_tax_minor + tip_minor,
    currency_code,
    tax_lines,
  };
}