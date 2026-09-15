import { describe, it, expect, beforeEach } from "vitest";
import { setActiveBusiness } from "../adapters/business";
import { setAuthProvider } from "../adapters/auth";
import { canBusinessSync, isAuthenticated, hasActiveBusiness } from "./sync-guard";

describe("sync-guard (Option C — business sync gated on auth+business)", () => {
  let token: string | null = null;
  beforeEach(() => {
    token = null;
    setAuthProvider(() => token);
    setActiveBusiness(null);
  });

  it("no token, no business → no sync", () => {
    expect(isAuthenticated()).toBe(false);
    expect(hasActiveBusiness()).toBe(false);
    expect(canBusinessSync()).toBe(false);
    expect(canBusinessSync("b1")).toBe(false);
  });

  it("token only, no business → no business sync, but isAuthenticated true", () => {
    token = "t";
    expect(isAuthenticated()).toBe(true);
    expect(hasActiveBusiness()).toBe(false);
    expect(canBusinessSync()).toBe(false);
    expect(canBusinessSync("")).toBe(false);
  });

  it("business only, no token → no sync", () => {
    setActiveBusiness({ id: "b1" });
    expect(isAuthenticated()).toBe(false);
    expect(hasActiveBusiness()).toBe(true);
    expect(canBusinessSync()).toBe(false);
    expect(canBusinessSync("b1")).toBe(false);
  });

  it("token + business → can sync", () => {
    token = "t";
    setActiveBusiness({ id: "b1" });
    expect(canBusinessSync()).toBe(true);
    expect(canBusinessSync("b1")).toBe(true);
  });

  it("explicit bid overrides store, but still needs token", () => {
    token = "t";
    setActiveBusiness({ id: "other" });
    expect(canBusinessSync("b1")).toBe(true);
    token = null;
    expect(canBusinessSync("b1")).toBe(false);
  });
});
