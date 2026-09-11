import { describe, it, expect } from "vitest";
import { backoffDelayMs, backoffCenterMs, BackoffTracker, BACKOFF_MAX_MS } from "./backoff";

describe("backoff curve", () => {
  it("doubles from 2s to the 5min cap", () => {
    expect(backoffCenterMs(0)).toBe(2_000);
    expect(backoffCenterMs(1)).toBe(4_000);
    expect(backoffCenterMs(2)).toBe(8_000);
    expect(backoffCenterMs(7)).toBe(256_000);
    expect(backoffCenterMs(8)).toBe(BACKOFF_MAX_MS);
    expect(backoffCenterMs(100)).toBe(BACKOFF_MAX_MS);
    expect(BACKOFF_MAX_MS).toBe(5 * 60_000);
  });

  it("negative attempts clamp to base", () => {
    expect(backoffCenterMs(-3)).toBe(2_000);
  });

  it("jitter stays within ±20% and never negative", () => {
    for (let i = 0; i < 200; i++) {
      const d = backoffDelayMs(3);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeGreaterThanOrEqual(16_000 * 0.8);
      expect(d).toBeLessThanOrEqual(16_000 * 1.2);
    }
  });

  it("tracker counts up and resets per scope", () => {
    const t = new BackoffTracker();
    expect(t.count("a")).toBe(0);
    t.next("a");
    t.next("a");
    expect(t.count("a")).toBe(2);
    expect(t.count("b")).toBe(0);
    t.reset("a");
    expect(t.count("a")).toBe(0);
    t.next("a");
    t.next("b");
    t.resetAll();
    expect(t.count("a")).toBe(0);
    expect(t.count("b")).toBe(0);
  });
});
