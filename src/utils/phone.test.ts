import { describe, it, expect } from "vitest";
import { normalizePhoneForCountry, isLikelyE164, getDialCodeFromCountry } from "./phone";

describe("phone", () => {
  it("normalizes GH numbers", () => {
    expect(normalizePhoneForCountry("0501234567", "GH")).toBe("+233501234567");
    expect(normalizePhoneForCountry("+233501234567", "GH")).toBe("+233501234567");
    expect(normalizePhoneForCountry("  ", "GH")).toBeNull();
  });

  it("validates E.164", () => {
    expect(isLikelyE164("+233501234567")).toBe(true);
    expect(isLikelyE164("0501234567")).toBe(false);
    expect(isLikelyE164("+1abc")).toBe(false);
  });

  it("resolves dial codes", () => {
    expect(getDialCodeFromCountry("GH")).toBe("+233");
    expect(getDialCodeFromCountry("US")).toBe("+1");
    expect(getDialCodeFromCountry("XX")).toBeNull();
  });
});
