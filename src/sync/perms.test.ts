import { describe, it, expect, beforeEach } from "vitest";
import { CAPABILITY_BY_COMMAND } from "../reference/capabilities";
import { setItemSync, removeItemSync } from "../adapters/kv";

describe("perms guard", () => {
  it("maps order:create to pos:create_order", () => {
    expect(CAPABILITY_BY_COMMAND["order:create"]).toBe("pos:create_order");
    expect(CAPABILITY_BY_COMMAND["menu:update_item"]).toBe("menu:manage");
  });

  it("hasCapabilitySyncSync fail open when no cache", async () => {
    const { hasCapabilitySync } = await import("../reference/capabilities");
    // without DB, should return true (fail open)
    // we can't easily test without DB, just ensure it resolves
    const res = await hasCapabilitySync("biz-no-cache", "order:create");
    expect(res).toBe(true);
  });
});
