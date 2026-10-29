/**
 * Offline device license — Ed25519 verification and evaluation.
 *
 * The backend signs a device-bound license once the terminal is activated
 * online. The app verifies it locally with the cached public key and uses the
 * monotonic entitlement clock for expiry, so changing the device wall-clock
 * cannot extend offline access.
 */

import { sha512 } from "@noble/hashes/sha512";
import * as ed from "@noble/ed25519";
import { anchorServerTime, getServerNowMs } from "../reference/entitlement-clock";

// `@noble/ed25519` needs a SHA-512 implementation for Ed25519. Hermes has no
// native Ed25519, so use the audited pure-JS hash.
ed.etc.sha512Async = async (message: Uint8Array) => sha512(message);

export const OFFLINE_LICENSE_VERSION = "v1";

export interface OfflineLicenseFeatures {
  [key: string]: unknown;
}

export interface OfflineLicensePayload {
  v: number;
  license_id: string;
  business_id: string;
  device_id: string;
  device_number: string;
  member_id: string;
  features: OfflineLicenseFeatures;
  business_type?: string | null;
  subscription_status?: string | null;
  current_period_end?: string | null;
  grace_until?: string | null;
  server_time: string;
  issued_at: string;
  expires_at: string;
  max_offline_days: number;
}

export type OfflineLicenseState = "active" | "expired" | "invalid" | "unverified";

export interface OfflineLicenseEvaluation {
  state: OfflineLicenseState;
  valid: boolean;
  entitled: boolean;
  mustReconnect: boolean;
  payload: OfflineLicensePayload | null;
  serverNowMs: number;
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const trio = (a << 16) | (b << 8) | c;
    out += B64_ALPHABET[(trio >> 18) & 63];
    out += B64_ALPHABET[(trio >> 12) & 63];
    if (i + 1 < bytes.length) out += B64_ALPHABET[(trio >> 6) & 63];
    if (i + 2 < bytes.length) out += B64_ALPHABET[trio & 63];
  }
  return out;
}

export function base64UrlDecode(value: string): Uint8Array {
  const clean = value.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const index = B64_ALPHABET.indexOf(clean[i]);
    if (index < 0) throw new Error("Invalid base64url");
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function textFromBytes(value: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const first = value[i++];
    if (first < 0x80) {
      out += String.fromCharCode(first);
    } else if (first < 0xe0) {
      out += String.fromCharCode(((first & 0x1f) << 6) | (value[i++] & 0x3f));
    } else if (first < 0xf0) {
      out += String.fromCharCode(
        ((first & 0x0f) << 12) | ((value[i++] & 0x3f) << 6) | (value[i++] & 0x3f),
      );
    } else {
      const cp =
        ((first & 0x07) << 18) |
        ((value[i++] & 0x3f) << 12) |
        ((value[i++] & 0x3f) << 6) |
        (value[i++] & 0x3f);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

export function splitLicense(token: string): {
  version: string;
  keyId: string;
  payloadBytes: Uint8Array;
  signature: Uint8Array;
} | null {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== OFFLINE_LICENSE_VERSION) return null;
  try {
    return {
      version: parts[0],
      keyId: parts[1],
      payloadBytes: base64UrlDecode(parts[2]),
      signature: base64UrlDecode(parts[3]),
    };
  } catch {
    return null;
  }
}

export function decodeLicensePayload(token: string): OfflineLicensePayload | null {
  const split = splitLicense(token);
  if (!split) return null;
  try {
    const parsed = JSON.parse(textFromBytes(split.payloadBytes)) as OfflineLicensePayload;
    if (!parsed?.license_id || !parsed?.business_id || !parsed?.device_id) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Verify a license token against the public key cached at activation.
 * An optional business id prevents a valid license for one tenant being
 * replayed into another tenant on the same device.
 */
export async function verifyOfflineLicense(
  token: string,
  publicKeyB64: string,
  expectedBusinessId?: string,
): Promise<OfflineLicensePayload | null> {
  const split = splitLicense(token);
  if (!split) return null;
  try {
    const publicKey = base64UrlDecode(publicKeyB64);
    if (publicKey.length !== 32) return null;
    const ok = await ed.verifyAsync(split.signature, split.payloadBytes, publicKey);
    if (!ok) return null;
    const payload = decodeLicensePayload(token);
    if (!payload) return null;
    if (expectedBusinessId && payload.business_id !== expectedBusinessId) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Evaluate a verified license using the server-anchored monotonic clock. */
export async function evaluateOfflineLicense(
  payload: OfflineLicensePayload | null,
): Promise<OfflineLicenseEvaluation> {
  if (!payload) {
    return {
      state: "invalid",
      valid: false,
      entitled: false,
      mustReconnect: true,
      payload: null,
      serverNowMs: await getServerNowMs(),
      reason: "Offline license is missing or invalid",
    };
  }

  await anchorServerTime(payload.server_time);
  const serverNowMs = await getServerNowMs();
  const expiresMs = Date.parse(payload.expires_at);
  const graceMs = payload.grace_until ? Date.parse(payload.grace_until) : NaN;

  if (!Number.isFinite(expiresMs)) {
    return {
      state: "invalid",
      valid: false,
      entitled: false,
      mustReconnect: true,
      payload,
      serverNowMs,
      reason: "Offline license has no valid expiry",
    };
  }

  if (serverNowMs <= expiresMs || (Number.isFinite(graceMs) && serverNowMs <= graceMs)) {
    return {
      state: "active",
      valid: true,
      entitled: true,
      mustReconnect: false,
      payload,
      serverNowMs,
      reason: "Offline license is valid",
    };
  }

  return {
    state: "expired",
    valid: true,
    entitled: false,
    mustReconnect: true,
    payload,
    serverNowMs,
    reason: `Offline license expired — reconnect to renew (max ${payload.max_offline_days} days)`,
  };
}

export async function loadAndVerifyOfflineLicense(args: {
  token: string | null;
  publicKey: string | null;
  businessId?: string;
}): Promise<{
  payload: OfflineLicensePayload | null;
  evaluation: OfflineLicenseEvaluation;
}> {
  if (!args.token || !args.publicKey) {
    return {
      payload: null,
      evaluation: await evaluateOfflineLicense(null),
    };
  }
  const payload = await verifyOfflineLicense(args.token, args.publicKey, args.businessId);
  return {
    payload,
    evaluation: await evaluateOfflineLicense(payload),
  };
}

/** Canonical message the device signs for `/auth/offline/exchange`. */
export function canonicalDeviceChallenge(args: {
  deviceId: string;
  licenseId: string;
  memberId: string;
  nonce: string;
  timestamp: string;
}): string {
  return [args.deviceId, args.licenseId, args.memberId, args.nonce, args.timestamp].join("|");
}

export async function signDeviceChallenge(privateKey: Uint8Array, message: string): Promise<string> {
  const signature = await ed.signAsync(textBytes(message), privateKey);
  return base64UrlEncode(signature);
}

export async function generateOfflineDeviceKeypair(
  randomBytes: (length: number) => Uint8Array,
): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array; publicKeyB64: string }> {
  const privateKey = randomBytes(32);
  if (privateKey.length !== 32) throw new Error("randomBytes must return 32 bytes");
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey, publicKeyB64: base64UrlEncode(publicKey) };
}

export function newOfflineNonce(randomBytes: (length: number) => Uint8Array): string {
  return base64UrlEncode(randomBytes(16));
}

/** Remove the per-business offline fields from an entitlement-shaped map. */
export function licenseFeatures(payload: OfflineLicensePayload | null): Record<string, unknown> | null {
  return payload?.features ?? null;
}

export const OFFLINE_LICENSE_MAX_DAYS = 30;
export const OFFLINE_LICENSE_DAY_MS = DAY_MS;
