import { describe, it, expect } from "vitest";
import { tickHLC, compareHLCString, hlcToString, hlcFromString } from "./hlc";

describe("HLC", () => {
  it("monotonic wall", () => {
    const a = tickHLC(1000, null, "01");
    const b = tickHLC(1001, a, "01");
    expect(compareHLCString(hlcToString(b), hlcToString(a))).toBeGreaterThan(0);
  });
  it("counter on same wall", () => {
    const a = tickHLC(1000, null, "01");
    const b = tickHLC(1000, a, "01");
    expect(b.counter).toBe(1);
  });
  it("skew bump", () => {
    const a = tickHLC(1000, null, "01");
    const b = tickHLC(999, a, "02");
    expect(b.wallMs).toBe(1000);
    expect(b.counter).toBe(1);
  });
  it("deviceId tie-break", () => {
    const a = { wallMs: 1000, counter: 0, deviceId: "01" };
    const b = { wallMs: 1000, counter: 0, deviceId: "02" };
    expect(compareHLCString(hlcToString(a), hlcToString(b))).toBeLessThan(0);
  });
  it("roundtrip", () => {
    const h = { wallMs: 1714560000000, counter: 2, deviceId: "10" };
    expect(hlcFromString(hlcToString(h))).toEqual(h);
  });
});
