import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { setReferenceData } from "../reference/operations";
import {
  setEntitlementSecret,
  assertEntitledForCommand,
  isEntitlementGated,
} from "./entitlement-guard";
import { signEntitlementEnvelope } from "./entitlements";

const BID = "biz-ent-guard";
const SECRET = "test-secret";

function envelope(expiresAt: string | null) {
  const base = {
    version: "v1",
    server_time: new Date().toISOString(),
    expires_at: expiresAt,
    grace_until: null,
    max_offline_days: 7,
    algorithm: "hmac-sha256",
  };
  return { ...base, signature: signEntitlementEnvelope(BID, base, SECRET) };
}

async function seed(features: Record<string, unknown>, expiresAt: string | null) {
  const db = await openSyncDatabase();
  await setReferenceData(db, BID, {
    key: "subscription:entitlements",
    version: "v1",
    payload: { data: features, envelope: envelope(expiresAt) },
    downloadedAt: new Date().toISOString(),
  });
}

const ACTIVE_FEATURES = {
  subscription_status: "active",
  "seller.promo": true,
  "fleet.dispatch": false,
};

describe("entitlement auto-guard", () => {
  beforeEach(async () => {
    setSqliteDriver(createMemoryDriver() as never);
    try {
      await closeSyncDatabase();
    } catch {}
    await openSyncDatabase();
    setEntitlementSecret(SECRET);
  });

  it("allows gated commands with a valid envelope", async () => {
    await seed(ACTIVE_FEATURES, new Date(Date.now() + 86400000).toISOString());
    await expect(assertEntitledForCommand(BID, "menu:create_item")).resolves.toBeUndefined();
    await expect(assertEntitledForCommand(BID, "promo:create")).resolves.toBeUndefined();
  });

  it("denies promo:create when the feature is off", async () => {
    await seed(
      { ...ACTIVE_FEATURES, "seller.promo": false },
      new Date(Date.now() + 86400000).toISOString(),
    );
    await expect(assertEntitledForCommand(BID, "promo:create")).rejects.toMatchObject({
      code: "SUBSCRIPTION_REQUIRED",
    });
    // Overall-entitled commands still pass.
    await expect(assertEntitledForCommand(BID, "menu:create_item")).resolves.toBeUndefined();
  });

  it("denies when expired", async () => {
    await seed(ACTIVE_FEATURES, new Date(Date.now() - 86400000).toISOString());
    await expect(assertEntitledForCommand(BID, "menu:create_item")).rejects.toMatchObject({
      code: "SUBSCRIPTION_REQUIRED",
    });
  });

  it("denies without a secret (unverified)", async () => {
    await seed(ACTIVE_FEATURES, new Date(Date.now() + 86400000).toISOString());
    setEntitlementSecret(null);
    await expect(assertEntitledForCommand(BID, "order:create")).rejects.toMatchObject({
      code: "SUBSCRIPTION_REQUIRED",
    });
  });

  it("allows when no envelope was ever cached (backend decides)", async () => {
    await expect(assertEntitledForCommand(BID, "order:create")).resolves.toBeUndefined();
  });

  it("ignores non-gated commands", async () => {
    expect(isEntitlementGated("order:accept")).toBe(false);
    await expect(assertEntitledForCommand(BID, "order:accept")).resolves.toBeUndefined();
  });
});
