/**
 * Local Node security helpers — platform-agnostic.
 *
 * SINGLE OWNER of mesh crypto (formula + inputs). Apps (Business/Desktop/Rust)
 * MUST NOT derive or re-implement this: core derives the secret once per
 * business and hands the opaque value to transports. Transports only carry it.
 *
 * Mesh decision: the secret is business-only — `SHA256("teinc-lan:{id}:")`
 * with a permanently empty owner segment. Same business_id ⇒ same secret on
 * every device, regardless of which owner fields each app's store happens to
 * carry (that variance caused `invalid_proof` between devices). The trailing
 * colon is kept so the wire value is byte-identical to the historic formula.
 *
 * Pure JS WebCrypto/Node fallback so core does not depend on expo-crypto.
 */

const LAN_SECRET_SALT = "teinc-lan";

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
  // 3) Pure-JS SHA-256 (Hermes/RN has neither subtle nor node crypto).
  // MUST be real SHA-256 — proofs must verify cross-platform, and the old
  // DJB placeholder produced zero-padded non-hashes that silently failed
  // every handshake. No app action needed: identical output everywhere.
  return bytesToHex(sha256Pure(data));
}

/**
 * Self-contained SHA-256 (FIPS 180-4), no platform dependency. Slower than
 * native but handshake-rate only. Pinned by vectors in security.test.ts.
 */
export function sha256Pure(data: Uint8Array): Uint8Array {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const bitLen = data.length * 8;
  const paddedLen = (((data.length + 8) >> 6) + 1) << 6;
  const msg = new Uint8Array(paddedLen);
  msg.set(data);
  msg[data.length] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(paddedLen - 4, bitLen >>> 0, false);
  dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  const w = new Int32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => odv.setInt32(i * 4, v, false));
  return out;
}

export async function deriveLanSecret(business: { id: string }): Promise<string> {
  return sha256Hex(`${LAN_SECRET_SALT}:${business.id}:`);
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
