/**
 * Subscription entitlements — offline evaluation with own counter.
 *
 * Rules (fail-closed):
 * - Envelope signature must verify, else NOT entitled (tamper-proof cache).
 * - Expiry uses the monotonic entitlement clock anchored to backend
 *   `server_time`, never `Date.now()` / device wall-clock.
 * - Stale cache beyond `max_offline_days` (7) forces reconnect (read-only).
 * - Unknown/missing state => not entitled. The backend remains the authority
 *   (HTTP 402 on gated calls); this is the offline UX gate that cannot be
 *   bypassed by editing SQLite, backdating the clock, or poisoning HLC.
 */

import { hmacSha256Hex } from "./entitlement-crypto";
import { anchorServerTime, getLastAnchorMs, getServerNowMs } from "./entitlement-clock";

export const ENTITLEMENTS_KEY = "subscription:entitlements" as const;

/** Keys that only the server may write (no local merge, no LAN override). */
export const SERVER_AUTHORITATIVE_KEYS: readonly string[] = [ENTITLEMENTS_KEY];

export function isServerAuthoritativeKey(key: string): boolean {
  return (SERVER_AUTHORITATIVE_KEYS as readonly string[]).includes(key);
}

export interface EntitlementEnvelope {
  version: string;
  server_time: string;
  expires_at: string | null;
  grace_until: string | null;
  max_offline_days: number;
  algorithm: string;
  signature: string;
}

export type EntitlementState =
  | "active"
  | "trialing"
  | "grace"
  | "expired"
  | "stale-blocked"
  | "unverified"
  | "no-plan";

export interface EntitlementEvaluation {
  state: EntitlementState;
  /** May the gated feature be used offline right now? */
  entitled: boolean;
  /** Anchored server instant used for the decision (ms). */
  serverNowMs: number;
  /** True when the cache is too stale and the user must reconnect. */
  mustReconnect: boolean;
  reason: string;
}

export function canonicalEnvelopePayload(
  businessId: string,
  envelope: Pick<EntitlementEnvelope, "version" | "server_time" | "expires_at" | "grace_until">,
): string {
  return [businessId, envelope.version, envelope.server_time, envelope.expires_at ?? "", envelope.grace_until ?? ""].join("|");
}

export function signEntitlementEnvelope(
  businessId: string,
  envelope: Pick<EntitlementEnvelope, "version" | "server_time" | "expires_at" | "grace_until">,
  secret: string,
): string {
  return hmacSha256Hex(secret, canonicalEnvelopePayload(businessId, envelope));
}

/** Constant-time-ish comparison to avoid trivial timing shortcuts. */
function signaturesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function verifyEntitlementEnvelope(
  businessId: string,
  envelope: EntitlementEnvelope | null | undefined,
  secret: string,
): boolean {
  if (!envelope || !secret) return false;
  if (!envelope.version || !envelope.server_time || !envelope.signature) return false;
  const expected = signEntitlementEnvelope(businessId, envelope, secret);
  return signaturesEqual(expected, envelope.signature.toLowerCase()) ||
    signaturesEqual(expected, envelope.signature);
}

export interface EvaluateInput {
  businessId: string;
  envelope: EntitlementEnvelope | null | undefined;
  /** Raw entitlements payload (`data` map with features + subscription_status). */
  features: Record<string, unknown> | null | undefined;
  secret: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function evaluateEntitlements(input: EvaluateInput): Promise<EntitlementEvaluation> {
  const { businessId, envelope, features, secret } = input;

  if (!envelope || !verifyEntitlementEnvelope(businessId, envelope, secret)) {
    return {
      state: "unverified",
      entitled: false,
      serverNowMs: await getServerNowMs(),
      mustReconnect: true,
      reason: "Entitlement signature invalid — reconnect to verify subscription",
    };
  }

  // Anchor the monotonic clock to this trusted server instant.
  // Stale envelopes never reset the anchor (see anchorServerTime).
  await anchorServerTime(envelope.server_time);
  const serverNowMs = await getServerNowMs();
  const lastAnchorMs = await getLastAnchorMs();

  const maxOfflineDays = Number.isFinite(envelope.max_offline_days) ? envelope.max_offline_days : 7;
  if (lastAnchorMs != null && serverNowMs - lastAnchorMs > maxOfflineDays * DAY_MS) {
    return {
      state: "stale-blocked",
      entitled: false,
      serverNowMs,
      mustReconnect: true,
      reason: `Subscription not verified for ${maxOfflineDays} days — reconnect required`,
    };
  }

  const status = String((features as Record<string, unknown> | undefined)?.["subscription_status"] ?? "none");
  const expiresMs = envelope.expires_at ? Date.parse(envelope.expires_at) : NaN;
  const graceMs = envelope.grace_until ? Date.parse(envelope.grace_until) : NaN;

  if (!Number.isFinite(expiresMs)) {
    // Legacy row without a period: entitled only when backend says so.
    const entitled = status === "active" || status === "trialing";
    return {
      state: entitled ? (status as EntitlementState) : "no-plan",
      entitled,
      serverNowMs,
      mustReconnect: false,
      reason: entitled ? "Active subscription (no period bound)" : "No subscription plan",
    };
  }

  if (serverNowMs <= expiresMs) {
    return {
      state: status === "trialing" ? "trialing" : "active",
      entitled: true,
      serverNowMs,
      mustReconnect: false,
      reason: "Subscription in period",
    };
  }

  if (Number.isFinite(graceMs) && serverNowMs <= graceMs) {
    return {
      state: "grace",
      entitled: true,
      serverNowMs,
      mustReconnect: false,
      reason: "Within grace period — renew soon",
    };
  }

  return {
    state: "expired",
    entitled: false,
    serverNowMs,
    mustReconnect: false,
    reason: "Subscription expired — upgrade to continue",
  };
}

/** Fail-closed feature read: unknown/expired/unverified => false. */
export function getEntitledFeature(
  evaluation: EntitlementEvaluation,
  features: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  if (!evaluation.entitled || !features) return false;
  return (features[key] as boolean) === true;
}

/** Fail-closed numeric limit read: unknown/expired/unverified => 0. */
export function getEntitledLimit(
  evaluation: EntitlementEvaluation,
  features: Record<string, unknown> | null | undefined,
  key: string,
): number {
  if (!evaluation.entitled || !features) return 0;
  const v = Number(features[key]);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}
