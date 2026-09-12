import { describe, it, expect, beforeEach, vi } from "vitest";
import { assertOnlineFor, ONLINE_REQUIRED } from "./online-gates";
import { setConnectivityState } from "../adapters/connectivity";

describe("online-gates", () => {
  beforeEach(() => {
    setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });
  });

  it("passes when online", () => {
    expect(() => assertOnlineFor("order:assign_rider")).not.toThrow();
  });

  it("throws for allowlisted types when offline", () => {
    setConnectivityState({ isOnline: false, isCloudReachable: "unreachable" });
    expect(() => assertOnlineFor("order:assign_rider")).toThrow("Assign rider requires online");
    expect(() => assertOnlineFor("member:invite")).toThrow();
    expect(() => assertOnlineFor("chat:send")).toThrow();
  });

  it("gates delivery and prepaid order:create by payload, cash passes offline", () => {
    setConnectivityState({ isOnline: false, isCloudReachable: "unreachable" });
    expect(() => assertOnlineFor("order:create", { order_type: "delivery" })).toThrow("Delivery orders require online");
    expect(() => assertOnlineFor("order:create", { pos_payment_method: "mobile_money" })).toThrow("Online payment requires online");
    expect(() => assertOnlineFor("order:create", { pos_payment_method: "cash" })).not.toThrow();
    expect(() => assertOnlineFor("order:create", {})).not.toThrow();
  });

  it("allowlist covers the agreed online-only surface", () => {
    for (const k of ["order:assign_rider", "order:confirm_handover", "chat:send", "member:invite", "kyc:submit", "wallet:withdraw"]) {
      expect(ONLINE_REQUIRED[k]).toBeTruthy();
    }
    void vi;
  });
});
