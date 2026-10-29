/**
 * Reference Data Synchronization Service.
 *
 * Responsible for downloading, versioning, and caching reference data
 * (menus, categories, modifiers, taxes, printers, etc.) locally.
 *
 * This service is separate from the Sync Engine, which handles transactional
 * commands and events.
 */

import { openSyncDatabase } from "../db/connection";
import { syncLogger } from "../utils/sync-logger";
import { generateUUID } from "../utils/uuid";
import { menuService, businessService, rolesService } from "../adapters/services";
import {
  cacheImageBatch,
  pruneImageCache,
  hasCachedImage,
  cacheImageFromBase64,
} from "../adapters/image-cache";
import { requestReferenceFromPeer, requestAssetFromPeer } from "../local-node/peer-bus";
import { getConnectivityState } from "../adapters/connectivity";
import { canBusinessSync } from "../sync/sync-guard";
import { getAuthToken } from "../adapters/auth";
import { paceSync, isRateLimited } from "../sync/rate-limit";
import type { MenuItemListResponse, BusinessResponse } from "../types/api";
import {
  getReferenceData,
  getReferenceVersion,
  mergeReferenceData,
  writeServerReferenceData,
} from "./operations";
import { anchorServerTime } from "./entitlement-clock";
import { isServerAuthoritativeKey } from "./entitlements";
import {
  fetchReferenceVersions,
  fetchReferenceData,
  fetchReferenceChanges,
} from "./api";
import type {
  ReferenceDataKey,
  ReferenceSyncOptions,
  ReferenceSyncResult,
  ReferenceDataRecord,
} from "./types";

const DEFAULT_SYNC_KEYS: ReferenceDataKey[] = [
  // Server-authoritative plan proof first: every gated command evaluates
  // against this, so it must never starve behind slow/heavy keys (menu
  // pagination). Capabilities second for the same reason (nav + guards).
  "subscription:entitlements",
  "capabilities",
  "menu:items",
  "menu:categories",
  "roles",
  "members",
  "tax-rules",
  "business:profile",
  "operating-hours",
  "delivery-settings",
  "payment-settings",
];

class ReferenceSyncService {
  /** Single-flight per business (a global flag made a business switch skip its sync). */
  private inflight = new Map<string, Promise<ReferenceSyncResult>>();
  /**
   * Keys requested while a pass was already running for that business.
   * They used to be dropped, which meant a menu edit could land while
   * another reference sync was in flight and never be fetched.
   */
  private queued = new Map<string, Set<ReferenceDataKey | "*">>();

  async sync(options: ReferenceSyncOptions): Promise<ReferenceSyncResult> {
    const businessId = options.businessId;
    if (!canBusinessSync(businessId)) {
      syncLogger.debug("ReferenceSync", "Skipping sync — no business/auth", {
        businessId,
      });
      return {
        synced: [],
        skipped: options.keys ?? DEFAULT_SYNC_KEYS,
        failed: [],
        errors: {} as Record<ReferenceDataKey, string>,
      };
    }

    const running = this.inflight.get(businessId);
    if (running) {
      // Remember the request so it is not lost, then wait for the pass that
      // is already running.
      this.rememberRequest(businessId, options.keys);
      try {
        return await running;
      } catch {
        return { synced: [], skipped: [], failed: [], errors: {} as Record<ReferenceDataKey, string> };
      }
    }

    const pass = (async () => {
      try {
        return await this.runSync(options);
      } finally {
        this.inflight.delete(businessId);
      }
    })();
    this.inflight.set(businessId, pass);

    let result: ReferenceSyncResult;
    try {
      result = await pass;
    } catch (error) {
      syncLogger.warn("ReferenceSync", "Sync pass failed", { businessId, error: String(error) });
      result = { synced: [], skipped: [], failed: [], errors: {} as Record<ReferenceDataKey, string> };
    }

    // Requests that arrived during the pass are served by one follow-up
    // pass — never silently dropped.
    const queued = this.queued.get(businessId);
    if (queued && queued.size > 0) {
      this.queued.delete(businessId);
      const wantsAll = queued.has("*");
      const keys = Array.from(queued).filter((k): k is ReferenceDataKey => k !== "*");
      const followUp: ReferenceSyncOptions = wantsAll
        ? { businessId }
        : { businessId, keys, incremental: true };
      syncLogger.info("ReferenceSync", "Running follow-up pass for queued keys", {
        businessId,
        all: wantsAll,
        keys,
      });
      await this.sync(followUp).catch(() => undefined);
    }

    return result;
  }

  private rememberRequest(businessId: string, keys?: ReferenceDataKey[]): void {
    const set = this.queued.get(businessId) ?? new Set<ReferenceDataKey | "*">();
    if (!keys || keys.length === 0) {
      set.add("*");
    } else {
      for (const key of keys) set.add(key);
    }
    this.queued.set(businessId, set);
  }

  private async runSync(options: ReferenceSyncOptions): Promise<ReferenceSyncResult> {
    const businessId = options.businessId;
    const { isOnline, isCloudReachable } = getConnectivityState();
    if (!isOnline || isCloudReachable === "unreachable") {
      // Dark LAN: a peer may still have the freshest reference rows and image
      // bytes. Compare against the mesh before declaring the pass empty.
      const keys = options.keys ?? DEFAULT_SYNC_KEYS;
      const lanResult: ReferenceSyncResult = {
        synced: [],
        skipped: keys,
        failed: [],
        errors: {} as Record<ReferenceDataKey, string>,
      };
      try {
        const db = await openSyncDatabase();
        const peer = await requestReferenceFromPeer(businessId, keys);
        if (peer?.data) {
          for (const key of keys) {
            const record = peer.data[key];
            if (!record) continue;
            const written = await writeServerReferenceData(
              db,
              businessId,
              key,
              record.payload,
              record.version,
            );
            if (written) lanResult.synced.push(key);
            else lanResult.skipped.push(key);
          }
          if (lanResult.synced.length > 0) {
            await this.cacheReferenceImages(db, businessId, lanResult.synced);
          }
        }
      } catch (error) {
        syncLogger.debug("ReferenceSync", "LAN reference catch-up unavailable", {
          businessId,
          error: String(error),
        });
      }
      return lanResult;
    }

    syncLogger.info("ReferenceSync", "Starting reference data sync", {
      businessId,
      keys: options.keys,
    });

    const result: ReferenceSyncResult = {
      synced: [],
      skipped: [],
      failed: [],
      errors: {} as Record<ReferenceDataKey, string>,
    };

    try {
      const db = await openSyncDatabase();
      const keys = options.keys ?? DEFAULT_SYNC_KEYS;

      // Attempt version-aware sync. If the backend does not support versioning
      // endpoints, fall back to legacy full-fetch per key.
      let versions: { key: ReferenceDataKey; version: string }[] | null = null;
      try {
        await paceSync();
        versions = await fetchReferenceVersions(options.businessId);
      } catch (error) {
        syncLogger.warn("ReferenceSync", "Version endpoint unavailable, using fallback", {
          error: String(error),
        });
      }

      for (const key of keys) {
        // Honour a global 429 cooldown: stop this pass; it resumes on the next
        // trigger once the window clears.
        if (isRateLimited()) {
          result.skipped.push(key);
          continue;
        }
        try {
          await paceSync();
          const synced = await this.syncKey(db, key, options, versions);
          if (synced) {
            result.synced.push(key);
          } else {
            result.skipped.push(key);
          }
        } catch (error) {
          result.failed.push(key);
          result.errors[key] = String(error);
          // A persisted-but-expired session can pass `canBusinessSync` on the
          // stale token; the first request then 401s and core's session
          // lifecycle clears auth mid-pass. Every remaining key would just fail
          // with "no authentication token" — abort quietly instead of emitting
          // one error per key. Expected logout, not a sync fault.
          if (!getAuthToken()) {
            for (const remaining of keys.slice(keys.indexOf(key) + 1)) {
              result.skipped.push(remaining);
            }
            syncLogger.warn(
              "ReferenceSync",
              "Aborting sync — session ended mid-pass (logged out)",
              { key },
            );
            break;
          }
          syncLogger.error("ReferenceSync", `Failed to sync ${key}`, {
            error: String(error),
          });
        }
      }

      // After a sync pass, download the images referenced by the freshly
      // cached payloads (menu items, business logo/cover) so the device can
      // display them while offline, then reclaim space from orphaned files.
      if (result.synced.length > 0) {
        await this.cacheReferenceImages(
          db,
          options.businessId,
          result.synced,
        );
      }
    } finally {
      syncLogger.info("ReferenceSync", "Reference data sync complete", {
        businessId,
        synced: result.synced,
        skipped: result.skipped,
        failed: result.failed,
      });
    }

    return result;
  }

  private async syncKey(
    db: Awaited<ReturnType<typeof openSyncDatabase>>,
    key: ReferenceDataKey,
    options: ReferenceSyncOptions,
    versions: { key: ReferenceDataKey; version: string }[] | null,
  ): Promise<boolean> {
    const { businessId } = options;
    const localVersion = await getReferenceVersion(db, businessId, key);

    // A key the backend does not version (e.g. during a gradual rollout) is
    // fetched with a full fetch + local hash so it is still cached offline.
    const serverVersion = versions?.find((v) => v.key === key)?.version;

    if (!options.force && localVersion && !options.incremental) {
      // In non-incremental mode without force, we still re-sync if version
      // info says there is a newer version on the server.
      if (serverVersion && serverVersion === localVersion) {
        syncLogger.debug("ReferenceSync", `Up to date: ${key}`, {
          version: localVersion,
        });
        return false;
      }
    }

    let payload: unknown;
    let version: string;

    if (versions && serverVersion) {
      if (localVersion && serverVersion !== localVersion) {
        try {
          const changeSet = await fetchReferenceChanges(
            businessId,
            key,
            localVersion,
          );
          payload = changeSet.changes;
          version = changeSet.to_version;
        } catch {
          // Fall back to full fetch if changes endpoint fails.
          const data = await fetchReferenceData(businessId, [key]);
          payload = data[key];
          version = serverVersion;
        }
      } else {
        const data = await fetchReferenceData(businessId, [key]);
        payload = data[key];
        version = serverVersion;
      }
    } else {
      // Backend does not support versioning for this key (or at all):
      // full fetch + local hash so the data is still cached offline.
      const fallback = await this.fetchFallback(key, businessId);
      payload = fallback.payload;
      version = fallback.version;
    }

    // LWW: newer HLC wins — local edits that are newer than server are preserved.
    // Server-authoritative keys (subscription:entitlements) bypass LWW merge:
    // only a newer verified server version overwrites, and the monotonic
    // clock anchors to the envelope server_time. Never wall-clock.
    const hlc = version ?? generateUUID();
    if (isServerAuthoritativeKey(key)) {
      const record = payload as {
        data?: unknown;
        envelope?: { version?: string; server_time?: string };
      } | null;
      const envelope = record && typeof record === "object" ? record.envelope : undefined;
      if (!envelope?.version || !envelope?.server_time) {
        syncLogger.error("ReferenceSync", `Refusing unverified ${key} payload (no envelope)`, {
          businessId,
        });
        throw new Error("Missing entitlement envelope");
      }
      const wrote = await writeServerReferenceData(db, businessId, key, payload as Record<string, unknown>, envelope.version);
      try {
        await anchorServerTime(envelope.server_time);
      } catch {}
      syncLogger.info("ReferenceSync", `Server-authoritative ${key} cached`, {
        businessId,
        version: envelope.version,
        server_time: envelope.server_time,
      });
      return wrote;
    }
    await mergeReferenceData(
      db,
      businessId,
      key,
      payload as Record<string, unknown>,
      hlc,
      `evt_${hlc}`,
    );

    return true;
  }

  private async fetchFallback(
    key: ReferenceDataKey,
    businessId: string,
  ): Promise<{ payload: unknown; version: string }> {
    switch (key) {
      case "menu:items": {
        // Paginate through all pages so offline cache is complete — not just page 1 (20).
        // Safety cap 50 pages (~1000 items) to avoid runaway on misconfigured backend.
        const allItems: MenuItemListResponse["data"] = [];
        let page = 1;
        let lastPagination: MenuItemListResponse["pagination"] | null = null;
        while (true) {
          const response = (await menuService.fetchBusinessMenuItems(
            businessId,
            page,
          )) as MenuItemListResponse;
          allItems.push(...(response.data ?? []));
          lastPagination = response.pagination;
          if (
            !lastPagination ||
            lastPagination.page >= lastPagination.total_pages ||
            (response.data ?? []).length === 0
          )
            break;
          page += 1;
          if (page > 50) break;
        }
        const merged: MenuItemListResponse = {
          data: allItems,
          pagination: lastPagination
            ? {
                ...lastPagination,
                page: 1,
                page_size: allItems.length,
                total_pages: 1,
                total_entries: allItems.length,
              }
            : {
                page: 1,
                page_size: allItems.length,
                total_pages: 1,
                total_entries: allItems.length,
              },
        };
        return {
          payload: merged,
          version: this.hashPayload(merged),
        };
      }
      case "menu:categories": {
        const response = await menuService.fetchBusinessCategories(businessId);
        return {
          payload: response,
          version: this.hashPayload(response),
        };
      }
      case "roles": {
        const response = await rolesService.fetchBusinessRoles();
        return {
          payload: response,
          version: this.hashPayload(response),
        };
      }
      case "members": {
        const response = await businessService.fetchBusinessMembers(businessId);
        return {
          payload: response,
          version: this.hashPayload(response),
        };
      }
      case "tax-rules": {
        const response = await businessService.fetchBusinessTaxRules(businessId);
        return {
          payload: response,
          version: this.hashPayload(response),
        };
      }
      case "business:profile": {
        const response = await businessService.fetchBusinessById(businessId);
        return {
          payload: response,
          version: this.hashPayload(response),
        };
      }
      case "operating-hours": {
        const response = await businessService.fetchOperatingHours(businessId);
        return {
          payload: response,
          version: this.hashPayload(response),
        };
      }
      case "capabilities": {
        const response = await businessService.fetchMyBusinessMembership(businessId);
        return {
          payload: response,
          version: this.hashPayload(response),
        };
      }
      case "delivery-settings": {
        const response = await (businessService as unknown as { fetchDeliverySettings: (id: string) => Promise<unknown> }).fetchDeliverySettings?.(businessId) ?? (await (await import("../adapters/http")).getHttpClient().get(`/businesses/${businessId}/delivery-settings`).then((r) => (r as unknown as { data: unknown }).data));
        return {
          payload: response,
          version: this.hashPayload(response),
        };
      }
      case "payment-settings": {
        const response = await businessService.fetchBusinessById(businessId);
        const payload = (response as unknown as { data?: { paymentSettings?: unknown } })?.data?.paymentSettings ?? response;
        return {
          payload,
          version: this.hashPayload(payload),
        };
      }
      case "subscription:entitlements": {
        // Direct full fetch; the syncKey server path requires the signed
        // envelope and anchors the monotonic clock. Never fabricate one here.
        const data = await fetchReferenceData(businessId, ["subscription:entitlements"]);
        const payload = data["subscription:entitlements"];
        const envelope = (payload as { envelope?: { version?: string } } | null)?.envelope;
        return {
          payload,
          version: envelope?.version ?? this.hashPayload(payload),
        };
      }
      default:
        throw new Error(`No fallback fetch available for ${key}`);
    }
  }

  /**
   * Download every image referenced by the given cached reference keys into
   * durable local storage, then prune orphaned files. Covers menu item photos
   * and the business logo/cover. Idempotent — already-cached images are
   * skipped. Errors never propagate: a failed download must not fail the sync.
   */
  private async cacheReferenceImages(
    db: Awaited<ReturnType<typeof openSyncDatabase>>,
    businessId: string,
    keys: ReferenceDataKey[],
  ): Promise<void> {
    try {
      const urls: (string | null | undefined)[] = [];

      if (keys.includes("menu:items")) {
        const cached = await getReferenceData<MenuItemListResponse>(
          db,
          businessId,
          "menu:items",
        );
        const items = cached?.payload?.data ?? [];
        urls.push(...items.map((item) => item.image_url));
      }

      if (keys.includes("business:profile")) {
        const cached = await getReferenceData<BusinessResponse>(
          db,
          businessId,
          "business:profile",
        );
        const business = cached?.payload?.data;
        if (business) {
          urls.push(business.logo_url, business.cover_image_url);
        }
      }

      if (urls.length === 0) return;

      const cachedImages = await cacheImageBatch(urls, {
        skipIfCached: true,
      });
      syncLogger.debug("ReferenceSync", "Reference images cached", {
        businessId,
        keys,
        count: cachedImages.length,
      });

      // Fully dark LAN: the cloud download cannot run, but a peer may already
      // have the bytes in its durable image cache. Fetch only missing keys.
      const peerConnectivity = getConnectivityState();
      if (!peerConnectivity.isOnline || peerConnectivity.isCloudReachable === "unreachable") {
        const missing: string[] = [];
        for (const url of urls) {
          if (!url || !url.startsWith("http")) continue;
          if (await hasCachedImage(url)) continue;
          missing.push(url);
        }
        // A menu can reference dozens of images. Keep peer transfers bounded so
        // a dark-LAN catch-up does not serialize 15s timeouts.
        const queue = [...missing];
        const worker = async () => {
          for (;;) {
            const url = queue.shift();
            if (!url) return;
            const asset = await requestAssetFromPeer(businessId, url);
            if (asset?.base64) {
              await cacheImageFromBase64(url, asset.base64);
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
      }

      await pruneImageCache(urls);
    } catch (error) {
      syncLogger.warn("ReferenceSync", "Failed to cache reference images", {
        error: String(error),
      });
    }
  }

  private hashPayload(payload: unknown): string {
    // Simple deterministic hash for fallback versioning.
    // Replace with a proper hash (e.g. SHA-256) when backend versioning is ready.
    const json = JSON.stringify(payload);
    let hash = 0;
    for (let i = 0; i < json.length; i++) {
      const char = json.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0;
    }
    return `hash-${Math.abs(hash).toString(16)}`;
  }

  async getCached<T>(
    businessId: string,
    key: ReferenceDataKey,
  ): Promise<ReferenceDataRecord<T> | null> {
    const db = await openSyncDatabase();
    return getReferenceData<T>(db, businessId, key);
  }
}

export const referenceSyncService = new ReferenceSyncService();
