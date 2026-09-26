import { describe, it, expect } from "vitest";
import { validateMenuItemInput, validateMenuCategoryInput, validateOrderCreateInput, validateInviteInput, ValidationError } from "./offline";

describe("offline validation mirror", () => {
  it("accepts a valid menu item", () => {
    expect(() =>
      validateMenuItemInput({ name: "Jollof", price_minor: 2500, category_id: "123e4567-e89b-12d3-a456-426614174000", variants: [{ name: "Big" }], extras: [] }),
    ).not.toThrow();
  });

  it("rejects exactly what the backend rejects", () => {
    expect(() => validateMenuItemInput({ name: "", price_minor: 1, category_id: "123e4567-e89b-12d3-a456-426614174000" })).toThrow(ValidationError);
    expect(() => validateMenuItemInput({ name: "X", price_minor: -5, category_id: "123e4567-e89b-12d3-a456-426614174000" })).toThrow(ValidationError);
    expect(() => validateMenuItemInput({ name: "X", price_minor: 5, category_id: "not-a-uuid" })).toThrow(ValidationError);
    expect(() => validateMenuItemInput({ name: "X", price_minor: 5, category_id: "123e4567-e89b-12d3-a456-426614174000", variants: [{ name: "" }] })).toThrow(ValidationError);
    try {
      validateMenuItemInput({ name: "", price_minor: 5, category_id: "123e4567-e89b-12d3-a456-426614174000" });
      expect.unreachable();
    } catch (e) {
      expect((e as ValidationError).details.name).toBeTruthy();
    }
  });

  it("validates categories, orders, invites", () => {
    expect(() => validateMenuCategoryInput({ name: "" })).toThrow(ValidationError);
    expect(() => validateOrderCreateInput({ items: [] })).toThrow(ValidationError);
    expect(() => validateOrderCreateInput({ items: [{ id: "1" }], total_minor: -1 })).toThrow(ValidationError);
    expect(() => validateOrderCreateInput({ items: [{ id: "1" }], order_type: "delivery" })).toThrow(ValidationError);
    expect(() => validateInviteInput({ email: "not-an-email" })).toThrow(ValidationError);
    expect(() => validateInviteInput({ email: "a@b.co" })).not.toThrow();
    // Phone is a first-class invite target.
    expect(() => validateInviteInput({ phone: "+233244123456" })).not.toThrow();
    expect(() => validateInviteInput({ phone: "0244123456" })).not.toThrow();
    expect(() => validateInviteInput({ phone: "abc" })).toThrow(ValidationError);
    expect(() => validateInviteInput({})).toThrow(ValidationError);
    expect(() => validateInviteInput({ email: "", phone: "" })).toThrow(ValidationError);
  });
});
