import { describe, it, expect } from "vitest";
import { formatPrice, formatPriceFromMinor, getCurrencySymbol, DEFAULT_CURRENCY } from "./currency";

describe("currency", () => {
  it("returns symbol for known currencies", () => {
    expect(getCurrencySymbol("GHS")).toBe("GH₵");
    expect(getCurrencySymbol("USD")).toBe("$");
    expect(getCurrencySymbol("UNKNOWN")).toBe("UNKNOWN");
  });

  it("formats price with default currency", () => {
    expect(formatPrice(10.5)).toBe(`${getCurrencySymbol(DEFAULT_CURRENCY)}10.50`);
  });

  it("formats price from minor units", () => {
    expect(formatPriceFromMinor(1050, "GHS")).toBe("GH₵10.50");
    expect(formatPriceFromMinor(100, "USD")).toBe("$1.00");
    expect(formatPriceFromMinor(0)).toBe(`${getCurrencySymbol(DEFAULT_CURRENCY)}0.00`);
  });
});
