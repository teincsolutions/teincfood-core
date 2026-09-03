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
import { cacheImageBatch, pruneImageCache } from "../adapters/image-cache";
import type { MenuItemListResponse, BusinessResponse } from "../types/api";
import {
  getReferenceData,
  getReferenceVersion,
  setReferenceData,
} from "./operations";
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
  "menu:items",
  "menu:categories",
  "roles",
  "members",
  "tax-rules",
  "business:profile",
  "operating-hours",
  "subscription:entitlements",
  "capabilities",
];

class ReferenceSyncService {
  private isSyncing = false;

  async sync(options: ReferenceSyncOptions): Promise<ReferenceSyncResult> {
    if (this.isSyncing) {
      return {
        synced: [],
        skipped: [],
        failed: [],
        errors: {} as Record<ReferenceDataKey, string>,
      };
    }

    this.isSyncing = true;
    syncLogger.info("ReferenceSync", "Starting reference data sync", {
      businessId: options.businessId,
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
        versions = await fetchReferenceVersions(options.businessId);
      } catch (error) {
        syncLogger.warn("ReferenceSync", "Version endpoint unavailable, using fallback", {
          error: String(error),
        });
      }

      for (const key of keys) {
        try {
          const synced = await this.syncKey(db, key, options, versions);
          if (synced) {
            result.synced.push(key);
          } else {
            result.skipped.push(key);
          }
        } catch (error) {
          result.failed.push(key);
          result.errors[key] = String(error);
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
      this.isSyncing = false;
    }

    syncLogger.info("ReferenceSync", "Reference data sync complete", {
      synced: result.synced,
      skipped: result.skipped,
      failed: result.failed,
    });

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

    await setReferenceData(db, businessId, {
      key,
      version: version ?? generateUUID(),
      payload,
      downloadedAt: new Date().toISOString(),
      lastHlc: version ?? generateUUID(),
      lastEventId: `evt_${version ?? generateUUID()}`,
    });

    return true;
  }

  private async fetchFallback(
    key: ReferenceDataKey,
    businessId: string,
  ): Promise<{ payload: unknown; version: string }> {
    switch (key) {
      case "menu:items": {
        const response = await menuService.fetchBusinessMenuItems(businessId, 1);
        return {
          payload: response,
          version: this.hashPayload(response),
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
    return `local-${Math.abs(hash).toString(16)}`;
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
