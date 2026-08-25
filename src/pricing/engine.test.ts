/**
 * Server-parity tests for the pricing engine.
 *
 * Mirrors the backend ExUnit vectors in
 * pos_controller_test.exs (inclusive / exclusive / mixed) and the
 * rounding formulas in Orders.calculate_tax_amount. Golden values below come
 * directly from the Elixir implementation so the two runtimes never diverge.
 */
import { describe, it, expect } from "vitest";
import {
  calculatePricing,
  calculateTaxLines,
  calculateExclusiveTax,
  calculateInclusiveTaxShare,
} from "./engine";
import type { POSCartItem } from "../types/pos.types";
import type { TaxRule } from "../types/api/business.api";

function cart(unitPriceMinor: number, quantity = 1, addonsMinor: number[] = []): POSCartItem[] {
  return [
    {
      id: "cart-1",
      menu_item: {
        id: "item-1",
        name: "Test Item",
        description: null,
        basePrice: { amountMinor: unitPriceMinor, currencyCode: "GHS" },
        image_url: null,
        is_available: true,
        dietary_tags: [],
        category_id: "cat-1",
        business_id: "biz-1",
        category: null,
        variants: [],
        extras: [],
        inserted_at: "",
        updated_at: "",
      },
      quantity,
      selected_variant: null,
      selected_addons: addonsMinor.map((price_minor, i) => ({
        addon_id: `addon-${i}`,
        name: `Addon ${i}`,
        price_minor,
      })),
      notes: "",
      // unit_price_minor already includes variant + addons (matches pos.store)
      unit_price_minor: unitPriceMinor,
    },
  ];
}

function taxRule(overrides: Partial<TaxRule> & { name: string; code: string; rate_basis_points: number }): TaxRule {
  return {
    id: "tax-1",
    business_id: "biz-1",
    country_code: "GH",
    applies_to: "subtotal",
    is_inclusive: false,
    is_active: true,
    display_order: 0,
    inserted_at: "",
    updated_at: "",
    ...overrides,
  };
}

describe("calculateExclusiveTax / calculateInclusiveTaxShare (backend rounding)", () => {
  it("computes exclusive tax = floor(amount*rate/10000)", () => {
    expect(calculateExclusiveTax(2400, 1000)).toBe(240); // 10%
    expect(calculateExclusiveTax(1200, 1000)).toBe(120);
    expect(calculateExclusiveTax(2400, 0)).toBe(0);
    expect(calculateExclusiveTax(0, 1000)).toBe(0);
  });

  it("computes inclusive share = floor(amount*rate/(10000+rate))", () => {
    // Backend: div(2400 * 7500 + 5000, 107500) = 1028
    expect(calculateInclusiveTaxShare(2400, 7500)).toBe(1028);
    expect(calculateInclusiveTaxShare(0, 7500)).toBe(0);
    expect(calculateInclusiveTaxShare(2400, 0)).toBe(0);
  });
});

describe("calculateTaxLines", () => {
  it("returns exclusive-only additions for exclusive rules", () => {
    const rules = [taxRule({ name: "Service", code: "service", rate_basis_points: 1000 })];
    const { tax_lines, tax_minor, exclusive_tax_minor } = calculateTaxLines(2400, rules);
    expect(tax_minor).toBe(240);
    expect(exclusive_tax_minor).toBe(240);
    expect(tax_lines[0].is_inclusive).toBe(false);
    expect(tax_lines[0].tax_amount_minor).toBe(240);
  });

  it("returns embedded amounts for inclusive rules (not added to total)", () => {
    const rules = [taxRule({ name: "Incl VAT", code: "incl_vat", rate_basis_points: 7500, is_inclusive: true })];
    const { tax_lines, tax_minor, exclusive_tax_minor } = calculateTaxLines(2400, rules);
    expect(tax_minor).toBe(1028); // display share
    expect(exclusive_tax_minor).toBe(0); // nothing added to total
    expect(tax_lines[0].is_inclusive).toBe(true);
    expect(tax_lines[0].tax_amount_minor).toBe(1028);
  });

  it("applies tax to discounted subtotal first", () => {
    const rules = [taxRule({ name: "Service", code: "service", rate_basis_points: 1000 })];
    const { exclusive_tax_minor } = calculateTaxLines(2400, rules, 400, 0); // 2000 taxable
    expect(exclusive_tax_minor).toBe(200);
  });

  it("honors applies_to = subtotal_plus_delivery", () => {
    const rules = [
      taxRule({ name: "Service", code: "service", rate_basis_points: 1000, applies_to: "subtotal_plus_delivery" }),
    ];
    const { exclusive_tax_minor } = calculateTaxLines(2400, rules, 0, 600); // 3000 taxable
    expect(exclusive_tax_minor).toBe(300);
  });
});

describe("calculatePricing (POS parity with backend)", () => {
  it("no tax → total == subtotal", () => {
    const pricing = calculatePricing({ items: cart(1200, 2), taxRules: [], currency_code: "GHS" });
    expect(pricing.subtotal_minor).toBe(2400);
    expect(pricing.total_minor).toBe(2400);
    expect(pricing.exclusive_tax_minor).toBe(0);
  });

  it("inclusive-only tax does NOT inflate total (backend vector: 2400 → 2400)", () => {
    const rules = [taxRule({ name: "Incl VAT", code: "incl_vat", rate_basis_points: 7500, is_inclusive: true })];
    const pricing = calculatePricing({ items: cart(1200, 2), taxRules: rules, currency_code: "GHS" });
    expect(pricing.subtotal_minor).toBe(2400);
    expect(pricing.total_minor).toBe(2400); // NOT 2400 + 168
    expect(pricing.exclusive_tax_minor).toBe(0);
    expect(pricing.tax_minor).toBe(1028);
    expect(pricing.tax_lines).toHaveLength(1);
    expect(pricing.tax_lines[0].is_inclusive).toBe(true);
  });

  it("exclusive tax is added on top (backend vector: 2400 → 2640)", () => {
    const rules = [taxRule({ name: "Service", code: "service", rate_basis_points: 1000 })];
    const pricing = calculatePricing({ items: cart(1200, 2), taxRules: rules, currency_code: "GHS" });
    expect(pricing.subtotal_minor).toBe(2400);
    expect(pricing.exclusive_tax_minor).toBe(240);
    expect(pricing.total_minor).toBe(2640);
  });

  it("mixed inclusive + exclusive adds only the exclusive portion (backend vector: 2640)", () => {
    const rules = [
      taxRule({ name: "Incl VAT", code: "incl_vat", rate_basis_points: 7500, is_inclusive: true }),
      taxRule({ name: "Service", code: "service", rate_basis_points: 1000 }),
    ];
    const pricing = calculatePricing({ items: cart(1200, 2), taxRules: rules, currency_code: "GHS" });
    expect(pricing.total_minor).toBe(2640);
    expect(pricing.exclusive_tax_minor).toBe(240);
    expect(pricing.tax_minor).toBe(1028 + 240); // display breakdown
    expect(pricing.tax_lines).toHaveLength(2);
  });

  it("applies tips when provided (POS total = subtotal + excl tax + tip)", () => {
    const rules = [taxRule({ name: "Service", code: "service", rate_basis_points: 1000 })];
    const pricing = calculatePricing({ items: cart(1200, 2), taxRules: rules, tip_minor: 500, currency_code: "GHS" });
    expect(pricing.total_minor).toBe(2400 + 240 + 500);
  });
});