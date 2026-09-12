/**
 * Reference-data React hooks — single source for both apps.
 * Sync hooks use core connectivity/business adapters; cache reads are pure
 * SQLite (never network). Image-query invalidation uses the shared
 * ["cachedImage"] prefix both apps use.
 */

import { useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { getConnectivityState, subscribeConnectivity } from "../adapters/connectivity";
import { openSyncDatabase } from "../db/connection";
import { referenceSyncService } from "./service";
import { getReferenceData } from "./operations";
import type { ReferenceDataKey, ReferenceSyncOptions, ReferenceSyncResult } from "./types";

export const REFERENCE_KEYS = {
  all: ["reference"] as const,
  sync: ["reference", "sync"] as const,
  data: (key: ReferenceDataKey) => ["reference", "data", key] as const,
};

function useActiveBusinessId(): string | undefined {
  const id = useSyncExternalStore(subscribeBusiness, () => getActiveBusiness()?.id ?? null, () => null);
  return id ?? undefined;
}

function useConnectivitySnapshot() {
  return useSyncExternalStore(subscribeConnectivity, getConnectivityState, getConnectivityState);
}

/**
 * Trigger reference data synchronization when the active business changes.
 * Does not return data; fires a background sync. Set `enabled` to false to
 * disable automatic sync.
 */
export function useReferenceDataSync(
  businessId: string | undefined,
  options: Omit<ReferenceSyncOptions, "businessId"> & { enabled?: boolean } = {},
) {
  const { enabled = true, ...syncOptions } = options;

  useEffect(() => {
    if (!enabled || !businessId) return;

    let cancelled = false;
    referenceSyncService
      .sync({ businessId, ...syncOptions })
      .then((result: ReferenceSyncResult) => {
        if (cancelled) return;
        if (result.failed.length > 0) {
          try {
            console.debug("[ReferenceSync] failed keys (non-fatal):", result.failed);
          } catch {}
        }
      })
      .catch(() => {
        if (cancelled) return;
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, enabled, JSON.stringify(syncOptions)]);
}

/** Manually trigger reference data sync. */
export function useSyncReferenceData() {
  return useCallback(async (options: ReferenceSyncOptions) => {
    return referenceSyncService.sync(options);
  }, []);
}

/**
 * App-level reference sync: downloads every reference-backed dataset into
 * the SQLite cache so the business operates fully offline. Call once from
 * the app root/layouts. Strict reachable gate — `unknown` (cold start)
 * must not fire sync, otherwise airplane launch hangs on versions fetch.
 */
export function useBusinessReferenceDataSync() {
  const businessId = useActiveBusinessId();
  const connectivity = useConnectivitySnapshot();
  const queryClient = useQueryClient();
  const isOnline = connectivity.isOnline;
  const isCloudReachable = connectivity.isCloudReachable;

  useEffect(() => {
    if (!businessId || !isOnline || isCloudReachable !== "reachable") return;

    let cancelled = false;
    referenceSyncService
      .sync({ businessId })
      .then((result: ReferenceSyncResult) => {
        if (cancelled) return;
        try {
          void queryClient.invalidateQueries({ queryKey: ["cachedImage"] });
        } catch {}
        if (result.failed.length > 0) {
          try {
            console.debug("[ReferenceSync] failed keys (non-fatal):", result.failed);
          } catch {}
        }
      })
      .catch(() => {
        if (cancelled) return;
      });

    return () => {
      cancelled = true;
    };
  }, [businessId, isOnline, isCloudReachable, queryClient]);
}

/**
 * Read a reference data record from the local SQLite cache for the active
 * business. Never hits the network.
 */
export function useReferenceData<T>(key: ReferenceDataKey) {
  const businessId = useActiveBusinessId();

  return useQuery({
    queryKey: [...REFERENCE_KEYS.data(key), businessId],
    queryFn: async () => {
      if (!businessId) return null;
      const db = await openSyncDatabase();
      return getReferenceData<T>(db, businessId, key);
    },
    staleTime: Infinity,
    enabled: !!businessId,
  });
}
