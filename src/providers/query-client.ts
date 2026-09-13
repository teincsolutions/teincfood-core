/**
 * Shared QueryClient factory — single source for query defaults + cache
 * persistence. Apps inject only platform specifics: the error toast and the
 * storage backend (MMKV on mobile, Tauri store on desktop).
 */

import { MutationCache, QueryClient } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { getConnectivityState } from "../adapters/connectivity";

export interface QueryPersistStorage {
  getItem: (key: string) => string | null | undefined | Promise<string | null | undefined>;
  setItem: (key: string, value: string) => void | Promise<void>;
  removeItem: (key: string) => void | Promise<void>;
}

export function createAppQueryClient(onMutationError: (message: string) => void): QueryClient {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error) => {
        try {
          onMutationError(error instanceof Error ? error.message : "Something went wrong");
        } catch {}
      },
    }),
    defaultOptions: {
      queries: {
        // Offline-first: when the cloud is known unreachable (health probe
        // failed / backend down), fail fast with zero retries — retrying a
        // dead backend only multiplies error spam. Transient failures while
        // reachable keep the standard 2 retries.
        retry: (failureCount, error) => {
          try {
            if (getConnectivityState().isCloudReachable === "unreachable") return false;
          } catch {}
          // Never retry explicit offline short-circuits (axios guard / adapters).
          const msg = error instanceof Error ? error.message : String(error ?? "");
          if (msg.startsWith("Offline") || (error as { code?: string })?.code === "OFFLINE") return false;
          return failureCount < 2;
        },
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        staleTime: 30 * 1000,
        gcTime: 5 * 60 * 1000,
      },
      mutations: {
        retry: 1,
      },
    },
  });
}

export function createQueryPersister(storage: QueryPersistStorage, key = "teincfood-query-cache", throttleTime = 1000) {
  return createAsyncStoragePersister({
    storage: {
      getItem: (k: string) => storage.getItem(k) as string | null | undefined | Promise<string | null | undefined>,
      setItem: (k: string, v: string) => storage.setItem(k, v),
      removeItem: (k: string) => storage.removeItem(k),
    },
    key,
    throttleTime,
  });
}
