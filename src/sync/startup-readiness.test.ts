import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { setKVDriver, setItemSync } from "../adapters/kv";
import { setConnectivityState } from "../adapters/connectivity";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { setReferenceData } from "../reference/operations";
import {
  getStartupReadiness,
  ensureStartupReady,
  REQUIRED_ORDER_KEYS,
} from "./startup-readiness";
import type { ReferenceDataKey } from "../reference/types";

const BID = "biz-readiness-test";

async function seedKey(key: ReferenceDataKey, payload: unknown = { data: [] }) {
  const db = await openSyncDatabase();
  await setReferenceData(db, BID, {
    key,
    version: "v1",
    payload,
    downloadedAt: new Date().toISOString(),
  });
}

async function seedAllKeys() {
  for (const key of REQUIRED_ORDER_KEYS) await seedKey(key);
}

describe("startup readiness", () => {
  beforeEach(async () => {
    setSqliteDriver(createMemoryDriver() as never);
    const kvStore = new Map<string, string>();
    setKVDriver({
      getItem: async (k: string) => kvStore.get(k) ?? null,
      setItem: async (k: string, v: string) => { kvStore.set(k, v); },
      removeItem: async (k: string) => { kvStore.delete(k); },
      getItemSync: (k: string) => kvStore.get(k) ?? null,
      setItemSync: (k: string, v: string) => { kvStore.set(k, v); },
      removeItemSync: (k: string) => { kvStore.delete(k); },
    } as never);
    try { await closeSyncDatabase(); } catch {}
    await openSyncDatabase();
    // Offline: readiness must evaluate the cache only, no network.
    setConnectivityState({ isOnline: false, isCloudReachable: "unreachable" });
  });

  it("not ready when reference keys are missing and no lease", async () => {
    const r = await getStartupReadiness(BID);
    expect(r.ready).toBe(false);
    expect(r.missingKeys.sort()).toEqual([...REQUIRED_ORDER_KEYS].sort());
    expect(r.needsLease).toBe(true);
  });

  it("not ready while a lease is missing even with all keys cached", async () => {
    await seedAllKeys();
    const r = await getStartupReadiness(BID);
    expect(r.missingKeys).toEqual([]);
    expect(r.needsLease).toBe(true);
    expect(r.ready).toBe(false);
  });

  it("ready when every key is cached and a device number is leased", async () => {
    await seedAllKeys();
    setItemSync(`teinc_device_number:${BID}`, "07");
    const r = await getStartupReadiness(BID);
    expect(r.missingKeys).toEqual([]);
    expect(r.needsLease).toBe(false);
    expect(r.ready).toBe(true);
  });

  it("reports missing keys precisely", async () => {
    await seedKey("menu:items");
    await seedKey("operating-hours");
    const r = await getStartupReadiness(BID);
    expect(r.missingKeys).not.toContain("menu:items");
    expect(r.missingKeys).not.toContain("operating-hours");
    expect(r.missingKeys).toContain("tax-rules");
    expect(r.missingKeys).toContain("capabilities");
  });

  it("ensureStartupReady is offline-safe and evaluates the cache", async () => {
    await seedAllKeys();
    setItemSync(`teinc_device_number:${BID}`, "07");
    const r = await ensureStartupReady(BID, { timeoutMs: 50 });
    expect(r.ready).toBe(true);
  });
});
