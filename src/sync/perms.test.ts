import { describe, it, expect, beforeEach } from "vitest";
import { CAPABILITY_BY_COMMAND, hasCapabilitySync } from "../reference/capabilities";
import { setItemSync, removeItemSync } from "../adapters/kv";

describe("perms guard", () => {
  it("maps order:create to orders_create (backend snake_case)", () => {
    expect(CAPABILITY_BY_COMMAND["order:create"]).toBe("orders_create");
    expect(CAPABILITY_BY_COMMAND["menu:update_item"]).toBe("menu_manage");
  });

  it("hasCapabilitySyncSync fail open when no cache", async () => {
    // without DB, should return true (fail open)
    const res = await hasCapabilitySync("biz-no-cache", "order:create");
    expect(res).toBe(true);
  });
});
