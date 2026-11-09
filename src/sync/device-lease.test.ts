import { describe, it, expect, beforeEach } from "vitest";
import { getDeviceNumber, isOnlineOnly, ensureLease } from "./device-lease.service";
import { removeItemSync, setItemSync } from "../adapters/kv";
import { setHttpClient } from "../adapters/http";

describe("device-lease", () => {
  beforeEach(() => {
    removeItemSync("teinc_device_number:biz1");
    removeItemSync("teinc_device_number:biz1:leased_at");
    removeItemSync("teinc_app_instance_id");
  });

  it("returns null when no lease", () => {
    expect(getDeviceNumber("biz1")).toBeNull();
    expect(isOnlineOnly("biz1")).toBe(true);
  });

  it("returns leased number after set", () => {
    setItemSync("teinc_device_number:biz1", "05");
    expect(getDeviceNumber("biz1")).toBe("05");
    expect(isOnlineOnly("biz1")).toBe(false);
  });

  it("rejects invalid DD 00", () => {
    setItemSync("teinc_device_number:biz1", "00");
    expect(getDeviceNumber("biz1")).toBeNull();
  });

  it("reserves DD 01 for online orders", () => {
    setItemSync("teinc_device_number:biz1", "01");
    expect(getDeviceNumber("biz1")).toBeNull();
    expect(isOnlineOnly("biz1")).toBe(true);
  });

  it("ensureLease handles 429 limit", async () => {
    // mock http client that returns 429
    setHttpClient({
      get: async () => ({ data: null } as any),
      post: async () => { throw Object.assign(new Error("DEVICE_LIMIT_REACHED"), { status: 429, name: "ApiError" }); },
      put: async () => ({ data: null } as any),
      patch: async () => ({ data: null } as any),
      delete: async () => ({ data: null } as any),
    });
    const res = await ensureLease("biz1");
    expect(res).toBeNull();
    expect(isOnlineOnly("biz1")).toBe(true);
  });
});
