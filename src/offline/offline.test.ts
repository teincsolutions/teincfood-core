import { describe, expect, it } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import {
  base64UrlEncode,
  canonicalDeviceChallenge,
  evaluateOfflineLicense,
  generateOfflineDeviceKeypair,
  verifyOfflineLicense,
  type OfflineLicensePayload,
} from "./license";
import {
  createOfflineMemberCredential,
  getOfflineMember,
  getOfflinePinLockState,
  listOfflineMembers,
  removeOfflineMember,
  saveOfflineMember,
  updateOfflineMemberRole,
  verifyOfflineMemberPin,
} from "./store";

ed.etc.sha512Async = async (message: Uint8Array) => sha512(message);

function payload(overrides: Partial<OfflineLicensePayload> = {}): OfflineLicensePayload {
  const now = new Date();
  return {
    v: 1,
    license_id: "license-1",
    business_id: "biz-1",
    device_id: "device-1",
    device_number: "01",
    member_id: "user-1",
    features: {
      "seller.pos.terminal": true,
      "subscription_status": "active",
      "business_type": "merchant",
    },
    business_type: "merchant",
    subscription_status: "active",
    current_period_end: new Date(now.getTime() + 86400000).toISOString(),
    grace_until: new Date(now.getTime() + 86400000 + 259200000).toISOString(),
    server_time: now.toISOString(),
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 86400000).toISOString(),
    max_offline_days: 30,
    ...overrides,
  };
}

async function signPayload(
  body: OfflineLicensePayload,
  privateKey: Uint8Array,
): Promise<{ token: string; publicKey: string }> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const signature = await ed.signAsync(bytes, privateKey);
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return {
    token: `v1.key1.${base64UrlEncode(bytes)}.${base64UrlEncode(signature)}`,
    publicKey: base64UrlEncode(publicKey),
  };
}

describe("offline license", () => {
  it("verifies a correctly signed license and rejects tampering", async () => {
    const keypair = await generateOfflineDeviceKeypair((n) => new Uint8Array(n).fill(7));
    const body = payload();
    const { token, publicKey } = await signPayload(body, keypair.privateKey);

    await expect(verifyOfflineLicense(token, publicKey, "biz-1")).resolves.toMatchObject({
      license_id: "license-1",
      business_id: "biz-1",
    });
    await expect(verifyOfflineLicense(token, publicKey, "other-biz")).resolves.toBeNull();

    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${base64UrlEncode(
      new Uint8Array(64),
    )}`;
    await expect(verifyOfflineLicense(tampered, publicKey, "biz-1")).resolves.toBeNull();
  });

  it("evaluates an active license as entitled", async () => {
    const body = payload();
    const evaluation = await evaluateOfflineLicense(body);
    expect(evaluation.state).toBe("active");
    expect(evaluation.valid).toBe(true);
    expect(evaluation.entitled).toBe(true);
  });

  it("evaluates an expired license as read-only", async () => {
    const past = new Date(Date.now() - 2 * 86400000).toISOString();
    const evaluation = await evaluateOfflineLicense(
      payload({ expires_at: past, grace_until: past, server_time: past }),
    );
    expect(evaluation.state).toBe("expired");
    expect(evaluation.entitled).toBe(false);
    expect(evaluation.mustReconnect).toBe(true);
  });

  it("canonical challenge is stable", () => {
    expect(
      canonicalDeviceChallenge({
        deviceId: "device-1",
        licenseId: "license-1",
        memberId: "user-1",
        nonce: "nonce",
        timestamp: "ts",
      }),
    ).toBe("device-1|license-1|user-1|nonce|ts");
  });
});

describe("offline member PIN", () => {
  it("enrolls and verifies a member without storing the raw PIN", async () => {
    await removeOfflineMember("member-1", "biz-1").catch(() => undefined);
    const member = await createOfflineMemberCredential({
      businessId: "biz-1",
      userId: "member-1",
      fullName: "Ama",
      role: "manager",
      capabilities: ["orders_create"],
      pin: "123456",
    });

    expect(member.pin_hash).not.toContain("123456");
    await expect(verifyOfflineMemberPin("member-1", "123456", "biz-1")).resolves.toBe(true);
    await expect(verifyOfflineMemberPin("member-1", "654321", "biz-1")).resolves.toBe(false);
    await expect(verifyOfflineMemberPin("member-1", "123456", "other-biz")).resolves.toBe(false);
    await expect(listOfflineMembers("biz-1")).resolves.toHaveLength(1);
    await removeOfflineMember("member-1", "biz-1");
  });

  it("locks a PIN after repeated failures and unlocks after the cooldown", async () => {
    await removeOfflineMember("member-lock", "biz-1").catch(() => undefined);
    await createOfflineMemberCredential({
      businessId: "biz-1",
      userId: "member-lock",
      fullName: "Kwame",
      role: "sales",
      capabilities: [],
      pin: "123456",
    });

    for (let i = 0; i < 5; i += 1) {
      await expect(verifyOfflineMemberPin("member-lock", "000000", "biz-1")).resolves.toBe(false);
    }

    const locked = await getOfflinePinLockState("member-lock", "biz-1");
    expect(locked.locked).toBe(true);
    expect(locked.remainingAttempts).toBe(0);
    await expect(verifyOfflineMemberPin("member-lock", "123456", "biz-1")).resolves.toBe(false);

    const member = await getOfflineMember("member-lock", "biz-1");
    await saveOfflineMember({
      ...member!,
      locked_until: new Date(Date.now() - 1000).toISOString(),
    });

    await expect(verifyOfflineMemberPin("member-lock", "123456", "biz-1")).resolves.toBe(true);
    await expect(getOfflinePinLockState("member-lock", "biz-1")).resolves.toMatchObject({
      failedAttempts: 0,
      locked: false,
    });
    await removeOfflineMember("member-lock", "biz-1");
  });

  it("applies offline role changes to the local credential", async () => {
    await removeOfflineMember("member-role", "biz-1").catch(() => undefined);
    await createOfflineMemberCredential({
      businessId: "biz-1",
      userId: "member-role",
      fullName: "Esi",
      role: "sales",
      capabilities: [],
      pin: "123456",
    });

    await updateOfflineMemberRole("member-role", "biz-1", "manager");
    await expect(getOfflineMember("member-role", "biz-1")).resolves.toMatchObject({
      role: "manager",
    });
    await removeOfflineMember("member-role", "biz-1");
  });
});
