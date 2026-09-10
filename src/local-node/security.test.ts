import { describe, it, expect } from "vitest";
import { deriveLanSecret, computeProof, sha256Pure } from "./security";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Lib-owned mesh crypto conformance. The Rust side
 * (TeincFoodDesktop/src-tauri/src/local_node/security.rs) asserts the same
 * vector — if either side drifts, devices stop proving and the mesh splits.
 */
describe("local-node security (lib-owned)", () => {
  it("derives the business-only mesh secret", async () => {
    // SHA256("teinc-lan:mesh-test-biz:") — owner segment permanently empty.
    await expect(deriveLanSecret({ id: "mesh-test-biz" })).resolves.toBe(
      "31e0b7e7ca5d01d9cd412d448592077f509f33f6eb5cee54f540046c2b37524d",
    );
  });

  it("ignores owner-shaped fields (same business ⇒ same secret)", async () => {
    const a = await deriveLanSecret({ id: "biz-1" });
    const b = await deriveLanSecret({ id: "biz-1", ownerId: "owner-1", owner_id: "owner-1" } as { id: string });
    expect(a).toBe(b);
  });

  it("pure-JS SHA-256 matches FIPS vectors (Hermes path)", () => {
    // Empty string and "abc" — the implementation every platform falls back to
    // must be real SHA-256, never a placeholder (see zero-padded DJB history).
    expect(hex(sha256Pure(new TextEncoder().encode("")))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hex(sha256Pure(new TextEncoder().encode("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // Cross-check pure fallback against node crypto on a mesh-shaped input.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require("crypto") as { createHash: (a: string) => { update: (b: Uint8Array) => { digest: (c: string) => string } } };
    const input = new TextEncoder().encode("teinc-lan:mesh-test-biz:");
    expect(hex(sha256Pure(input))).toBe(nodeCrypto.createHash("sha256").update(input).digest("hex"));
  });

  it("proves against the secret (prefix-keyed, matches Rust verify_proof)", async () => {
    const secret = await deriveLanSecret({ id: "mesh-test-biz" });
    const nonce = "0123456789abcdef0123456789abcdef";
    const proof = await computeProof(secret, nonce);
    expect(proof).toHaveLength(64);
    // Wrong nonce must not verify.
    const wrong = await computeProof(secret, "ffffffffffffffffffffffffffffffff");
    expect(wrong).not.toBe(proof);
  });
});
