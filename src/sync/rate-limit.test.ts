import { describe, it, expect, beforeEach } from "vitest";
import {
  noteRateLimited,
  isRateLimited,
  getRateLimitWaitMs,
  extractRetryAfterMs,
  shouldReportRateLimit,
  paceSync,
  resetRateLimitForTests,
  SYNC_MIN_INTERVAL_MS,
} from "./rate-limit";

describe("sync rate-limit gate", () => {
  beforeEach(() => resetRateLimitForTests());

  it("opens a cooldown and clears after the window", async () => {
    expect(isRateLimited()).toBe(false);
    noteRateLimited(30);
    expect(isRateLimited()).toBe(true);
    expect(getRateLimitWaitMs()).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 45));
    expect(isRateLimited()).toBe(false);
  });

  it("keeps the longest window when throttled again", () => {
    noteRateLimited(1000);
    const first = getRateLimitWaitMs();
    noteRateLimited(50);
    expect(getRateLimitWaitMs()).toBeGreaterThanOrEqual(first - 5);
  });

  it("reports only the first hit of a window", () => {
    noteRateLimited(1000);
    expect(shouldReportRateLimit()).toBe(true);
    noteRateLimited(1000);
    noteRateLimited(1000);
    expect(shouldReportRateLimit()).toBe(false);
  });

  it("parses retry_after_seconds from backend body and headers", () => {
    expect(
      extractRetryAfterMs({
        response: { data: { error: { retry_after_seconds: 60 } } },
      }),
    ).toBe(60_000);
    expect(
      extractRetryAfterMs({ response: { headers: { "retry-after": "12" } } }),
    ).toBe(12_000);
    expect(extractRetryAfterMs(new Error("no"))).toBeUndefined();
  });

  it("paces consecutive sync requests", async () => {
    const t0 = Date.now();
    await paceSync();
    await paceSync();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(SYNC_MIN_INTERVAL_MS - 30);
  });
});
