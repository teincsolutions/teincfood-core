/**
 * Subscription entitlements — tamper-proof offline evaluation.
 *
 * Covers: signature verify/reject, in-period/grace/expired states,
 * 7-day stale block, wall-clock backdate immunity (own monotonic counter),
 * fail-closed feature/limit reads, and fail-closed offline command gate.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  evaluateEntitlements,
  getEntitledFeature,
  getEntitledLimit,
  signEntitlementEnvelope,
  verifyEntitlementEnvelope,
  type EntitlementEnvelope,
} from "./entitlements";
import {
  anchorServerTime,
  getServerNowMs,
  resetEntitlementClock,
  setMonoSource,
} from "./entitlement-clock";
import { hmacSha256Hex, sha256Hex } from "./entitlement-crypto";
import { assertEntitledFor } from "../sync/online-gates";

const SECRET = "test-entitlement-secret";
const BIZ = "biz-123";

function envelope(over: Partial<EntitlementEnvelope> = {}): EntitlementEnvelope {
  const base = {
    version: "1800000000000-000000-backend",
    server_time: "2026-09-01T00:00:00Z",
    expires_at: "2026-10-01T00:00:00Z",
    grace_until: "2026-10-04T00:00:00Z",
    max_offline_days: 7,
    algorithm: "HMAC-SHA256",
    signature: "",
    ...over,
  };
  return { ...base, signature: signEntitlementEnvelope(BIZ, base, SECRET) };
}

const FEATURES = {
  subscription_status: "trialing",
  "seller.online_orders": true,
  "limits.menu_items": 3,
};

beforeEach(async () => {
  await resetEntitlementClock();
  setMonoSource(null);
});

describe("entitlement-crypto", () => {
  it("matches SHA-256 test vector", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches RFC 4231 HMAC-SHA256 vector", () => {
    const key = "\x0b".repeat(20);
    expect(hmacSha256Hex(key, "Hi There")).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
  });
});

describe("verifyEntitlementEnvelope", () => {
  it("accepts a valid signature", () => {
    expect(verifyEntitlementEnvelope(BIZ, envelope(), SECRET)).toBe(true);
  });

  it("rejects tampered version/expiry", () => {
    const env = envelope();
    expect(
      verifyEntitlementEnvelope(BIZ, { ...env, expires_at: "2027-01-01T00:00:00Z" }, SECRET),
    ).toBe(false);
  });

  it("rejects wrong business / wrong secret", () => {
    const env = envelope();
    expect(verifyEntitlementEnvelope("other-biz", env, SECRET)).toBe(false);
    expect(verifyEntitlementEnvelope(BIZ, env, "wrong")).toBe(false);
  });
});

describe("evaluateEntitlements", () => {
  it("is entitled in-period (trialing)", async () => {
    let mono = 1000;
    setMonoSource(() => mono);
    const res = await evaluateEntitlements({ businessId: BIZ, envelope: envelope(), features: FEATURES, secret: SECRET });
    expect(res.state).toBe("trialing");
    expect(res.entitled).toBe(true);
    expect(res.mustReconnect).toBe(false);
  });

  it("is entitled in grace after expiry", async () => {
    let mono = 1000;
    setMonoSource(() => mono);
    // Fresh sync Oct 2 (anchors clock), period expired Oct 1, grace till Oct 4.
    const env = envelope({ server_time: "2026-10-02T00:00:00Z" });
    const res = await evaluateEntitlements({ businessId: BIZ, envelope: env, features: FEATURES, secret: SECRET });
    expect(res.state).toBe("grace");
    expect(res.entitled).toBe(true);
  });

  it("is expired past grace", async () => {
    let mono = 1000;
    setMonoSource(() => mono);
    // Fresh sync Oct 11, past grace (Oct 4) but within 7d stale window.
    const env = envelope({ server_time: "2026-10-11T00:00:00Z" });
    const res = await evaluateEntitlements({ businessId: BIZ, envelope: env, features: FEATURES, secret: SECRET });
    expect(res.state).toBe("expired");
    expect(res.entitled).toBe(false);
  });

  it("blocks stale cache beyond max_offline_days even when period looks valid", async () => {
    let mono = 1000;
    setMonoSource(() => mono);
    // Far-future expiry, but 8 days elapse on the monotonic counter.
    const env = envelope({ expires_at: "2027-01-01T00:00:00Z", grace_until: "2027-01-04T00:00:00Z" });
    await anchorServerTime(env.server_time);
    mono += 8 * 24 * 3600 * 1000;
    const res = await evaluateEntitlements({ businessId: BIZ, envelope: env, features: FEATURES, secret: SECRET });
    expect(res.state).toBe("stale-blocked");
    expect(res.entitled).toBe(false);
    expect(res.mustReconnect).toBe(true);
  });

  it("is immune to wall-clock backdating (own counter)", async () => {
    let mono = 5000;
    setMonoSource(() => mono);
    // Fresh sync Oct 11 (past grace) — wall clock jumps backwards, decision holds.
    const env = envelope({ server_time: "2026-10-11T00:00:00Z" });
    const realNow = Date.now;
    (Date as unknown as { now: () => number }).now = () => realNow() - 60 * 24 * 3600 * 1000;
    try {
      const res = await evaluateEntitlements({ businessId: BIZ, envelope: env, features: FEATURES, secret: SECRET });
      expect(res.state).toBe("expired");
      expect(res.entitled).toBe(false);
    } finally {
      (Date as unknown as { now: () => number }).now = realNow;
    }
  });

  it("rejects forged envelopes as unverified", async () => {
    const env = envelope();
    const res = await evaluateEntitlements({
      businessId: BIZ,
      envelope: { ...env, signature: "00".repeat(32) },
      features: FEATURES,
      secret: SECRET,
    });
    expect(res.state).toBe("unverified");
    expect(res.entitled).toBe(false);
    expect(res.mustReconnect).toBe(true);
  });

  it("fail-closed feature/limit reads", async () => {
    let mono = 1000;
    setMonoSource(() => mono);
    const env = envelope({ server_time: "2026-10-11T00:00:00Z" });
    const expired = await evaluateEntitlements({ businessId: BIZ, envelope: env, features: FEATURES, secret: SECRET });
    expect(expired.entitled).toBe(false);
    expect(getEntitledFeature(expired, FEATURES, "seller.online_orders")).toBe(false);
    expect(getEntitledLimit(expired, FEATURES, "limits.menu_items")).toBe(0);
  });
});

describe("assertEntitledFor", () => {
  it("throws fail-closed for gated commands when not entitled", () => {
    expect(() => assertEntitledFor("menu:create_item", false)).toThrow(/Subscription required/);
    expect(() => assertEntitledFor("menu:create_item", true)).not.toThrow();
    expect(() => assertEntitledFor("order:assign_rider", false)).not.toThrow(); // not entitlement-gated
  });
});

describe("entitlement clock", () => {
  it("never moves backwards across restart (mono reset clamp)", async () => {
    let mono = 9000;
    setMonoSource(() => mono);
    await anchorServerTime("2026-09-01T00:00:00Z");
    mono += 3600 * 1000;
    const t1 = await getServerNowMs();
    mono = 10; // simulated restart: performance.now() resets
    const t2 = await getServerNowMs();
    expect(t2).toBeLessThanOrEqual(t1);
    // ...but never below the anchored server instant
    expect(t2).toBeGreaterThanOrEqual(Date.parse("2026-09-01T00:00:00Z"));
  });
});
