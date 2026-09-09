/**
 * Local Node security helpers — platform-agnostic.
 *
 * Pure JS WebCrypto/Node fallback so core does not depend on expo-crypto.
 * Business/Desktop may still derive via same formula.
 */

const LAN_SECRET_SALT = "teinc-lan";

function getOwnerId(business: { id: string } & Partial<Record<"ownerId" | "owner_id", string>>): string {
  return (business as { ownerId?: string }).ownerId ?? (business as { owner_id?: string }).owner_id ?? "";
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  // 1) WebCrypto (RN Hermes may expose global crypto.subtle, Tauri does)
  try {
    const g: unknown = globalThis as unknown;
    const subtle = (g as { crypto?: { subtle?: SubtleCrypto } })?.crypto?.subtle;
    if (subtle) {
      const buf = await subtle.digest("SHA-256", data);
      return bytesToHex(new Uint8Array(buf));
    }
  } catch {}
  // 2) Node crypto (tests / desktop node)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto: { createHash: (a: string) => { update: (b: Uint8Array) => { digest: (c: string) => string } } } = require("crypto");
    if (nodeCrypto?.createHash) return nodeCrypto.createHash("sha256").update(data).digest("hex");
  } catch {}
  // 3) Pure-JS fallback (should not happen — WebCrypto available in RN via expo-crypto polyfill if needed)
  // Minimal fallback: hash via simple DJB (not secure but keeps offline flow alive)
  let h = 5381;
  for (let i = 0; i < data.length; i++) h = ((h << 5) + h) ^ data[i];
  return Math.abs(h).toString(16).padStart(64, "0");
}

export async function deriveLanSecret(business: { id: string } & Partial<Record<"ownerId" | "owner_id", string>>): Promise<string> {
  return sha256Hex(`${LAN_SECRET_SALT}:${business.id}:${getOwnerId(business)}`);
}

export async function generateNonce(): Promise<string> {
  try {
    const g: unknown = globalThis as unknown;
    const cryptoObj = (g as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })?.crypto;
    if (cryptoObj?.getRandomValues) {
      const b = new Uint8Array(16);
      cryptoObj.getRandomValues(b);
      return bytesToHex(b);
    }
  } catch {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto: { randomBytes: (n: number) => Uint8Array } = require("crypto");
    if (nodeCrypto?.randomBytes) return bytesToHex(nodeCrypto.randomBytes(16));
  } catch {}
  // fallback Math.random
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return bytesToHex(b);
}

export async function computeProof(secret: string, nonce: string): Promise<string> {
  return sha256Hex(`${nonce}:${secret}`);
}
