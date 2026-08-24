import { describe, it, expect } from "vitest";
import { validateEmail, validatePhone, validatePassword, validatePromoCode } from "./validation";

describe("validation", () => {
  it("validates email", () => {
    expect(validateEmail("a@b.com").valid).toBe(true);
    expect(validateEmail("bad").valid).toBe(false);
    expect(validateEmail("").errors).toContain("Email is required");
  });

  it("validates phone", () => {
    expect(validatePhone("+233501234567").valid).toBe(true);
    expect(validatePhone("123").valid).toBe(true); // minimal valid per regex
    expect(validatePhone("").valid).toBe(false);
  });

  it("validates password strength", () => {
    expect(validatePassword("StrongPass1").valid).toBe(true);
    expect(validatePassword("short").valid).toBe(false);
    expect(validatePassword("nouppercase1").valid).toBe(false);
  });

  it("validates promo code", () => {
    expect(validatePromoCode("SAVE10").valid).toBe(true);
    expect(validatePromoCode("ab").valid).toBe(false);
  });
});
