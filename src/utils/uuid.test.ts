import { describe, it, expect } from "vitest";
import { generateUUID, generateCommandId, generateEventId } from "./uuid";

describe("uuid", () => {
  it("generates valid v4 UUIDs", () => {
    const id = generateUUID();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("generates prefixed ids", () => {
    expect(generateCommandId()).toMatch(/^cmd_/);
    expect(generateEventId()).toMatch(/^evt_/);
    expect(generateCommandId()).not.toBe(generateEventId());
  });
});
