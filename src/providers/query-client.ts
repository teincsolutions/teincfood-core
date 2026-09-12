/**
 * Shared QueryClient factory — single source for query defaults + cache
 * persistence. Apps inject only platform specifics: the error toast and the
 * storage backend (MMKV on mobile, Tauri store on desktop).
 */

import { MutationCache, QueryClient } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";

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
        retry: 2,
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
