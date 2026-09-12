import { describe, it, expect, beforeEach } from "vitest";
import { recordAttempt, getAttemptStats, resetAttemptStats } from "./attempt-stats";

describe("attempt-stats", () => {
  beforeEach(() => resetAttemptStats());

  it("counts totals and trailing-60s rates with caller detail", () => {
    recordAttempt("ws_reconnect", "delay=1000 attempt=1");
    recordAttempt("ws_reconnect", "delay=2000 attempt=2");
    recordAttempt("probe");
    const stats = getAttemptStats();
    const ws = stats.find((s) => s.subsystem === "ws_reconnect");
    const probe = stats.find((s) => s.subsystem === "probe");
    expect(ws?.total).toBe(2);
    expect(ws?.perMin).toBe(2);
    expect(ws?.lastDetail).toBe("delay=2000 attempt=2");
    expect(ws?.lastAt).toBeTruthy();
    expect(probe?.total).toBe(1);
    // hottest first
    expect(stats[0].subsystem).toBe("ws_reconnect");
  });

  it("returns empty when nothing recorded", () => {
    expect(getAttemptStats()).toEqual([]);
  });
});
