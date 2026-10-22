import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { setKVDriver } from "../adapters/kv";
import { setAuthProvider } from "../adapters/auth";
import { setActiveBusiness } from "../adapters/business";
import { setHttpClient } from "../adapters/http";
import { setConnectivityState } from "../adapters/connectivity";
import { openSyncDatabase, closeSyncDatabase } from "../db/connection";
import { performFullSync } from "./full-sync";
import { referenceSyncService } from "../reference/service";

describe("per-business sync state", () => {
  const httpGet = vi.fn();

  beforeEach(async () => {
    const mem = createMemoryDriver();
    setSqliteDriver(mem as never);
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
    setAuthProvider(() => "token-switch");
    setActiveBusiness({ id: "biz-A" } as never);
    setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });

    httpGet.mockReset();
    httpGet.mockImplementation(async () => ({
      data: { data: [], pagination: { total_pages: 1 } },
    }));
    setHttpClient({
      get: httpGet as never,
      post: vi.fn(async () => ({ data: {} })) as never,
      put: vi.fn(async () => ({ data: {} })) as never,
      patch: vi.fn(async () => ({ data: {} })) as never,
      delete: vi.fn(async () => ({ data: {} })) as never,
    });
  });

  it("syncs business B while business A is still syncing", async () => {
    const synced: string[] = [];
    const spy = vi.spyOn(referenceSyncService, "sync").mockImplementation(async (options) => {
      synced.push(options.businessId);
      await new Promise((r) => setTimeout(r, 40));
      return { synced: [], skipped: [], failed: [], errors: {} };
    });

    const a = performFullSync("biz-A");
    const b = performFullSync("biz-B");
    await Promise.all([a, b]);

    expect(synced).toContain("biz-A");
    expect(synced).toContain("biz-B");

    spy.mockRestore();
  });

  it("serves reference keys that were requested while a pass was running", async () => {
    const fetchedKeys: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    httpGet.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => {
      if (url.includes("reference-versions")) {
        await gate;
        return {
          data: {
            data: [
              { key: "menu:items", version: "v1" },
              { key: "tax-rules", version: "v1" },
            ],
          },
        };
      }
      if (url.includes("reference-data")) {
        fetchedKeys.push(String(config?.params?.keys ?? ""));
        return { data: { data: { "menu:items": { data: [] }, "tax-rules": { data: [] } } } };
      }
      return { data: { data: [] } };
    });

    const first = referenceSyncService.sync({ businessId: "biz-A", keys: ["menu:items"] });
    // Second request arrives while the first pass is still running.
    const second = referenceSyncService.sync({ businessId: "biz-A", keys: ["tax-rules"] });

    release?.();
    await first;
    await second;
    await new Promise((r) => setTimeout(r, 200));

    expect(fetchedKeys.some((k) => k.includes("menu:items"))).toBe(true);
    // The key requested during the running pass is fetched by a follow-up pass.
    expect(fetchedKeys.some((k) => k.includes("tax-rules"))).toBe(true);
  });
});
