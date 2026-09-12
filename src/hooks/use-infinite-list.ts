/**
 * Shared infinite-list primitive — the ONLY pagination implementation.
 *
 * Offline-first: SQLite/offline fetch serves instantly; the network fetch
 * refreshes silently when effectively online and falls back to offline on
 * error. Network is sync transport, never a render delay.
 *
 * Canonical pagination shape matches the backend (pagination.ex):
 * { page, page_size, total_entries, total_pages }.
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { getConnectivityState, subscribeConnectivity } from "../adapters/connectivity";
import { DEFAULT_PAGE_SIZE } from "../utils/constants";

export function useIsEffectivelyOnline(): boolean {
  const s = useSyncExternalStore(subscribeConnectivity, getConnectivityState, getConnectivityState);
  return s.isOnline && s.isCloudReachable !== "unreachable";
}

export interface ListPage<T> {
  data: T[];
  pagination: { page: number; page_size: number; total_pages: number; total_entries?: number };
}

export interface InfiniteListOptions<T> {
  key: readonly unknown[];
  enabled?: boolean;
  pageSize?: number;
  staleTime?: number;
  /**
   * Always-available local fetch (SQLite). Serves instantly offline.
   * Omit when there is no local source — offline then preserves stale
   * cache (query errors, data stays) instead of serving empty.
   */
  offlineFetch?: (page: number, pageSize: number) => Promise<ListPage<T>>;
  /** Network refresh. Failure falls back to offlineFetch, else stale cache. */
  onlineFetch?: (page: number, pageSize: number) => Promise<ListPage<T>>;
}

export function nextPageParam(lastPage: unknown): number | undefined {
  const p = (lastPage as { pagination?: { page: number; total_pages: number } })?.pagination;
  return p && p.page < p.total_pages ? p.page + 1 : undefined;
}

export function flattenPages<T>(pages: Array<{ data: T[] }>): T[] {
  return pages.flatMap((p) => p.data ?? []);
}

export function useInfiniteList<T>(options: InfiniteListOptions<T>) {
  const online = useIsEffectivelyOnline();
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const enabled = options.enabled ?? true;
  const query = useInfiniteQuery({
    queryKey: [...options.key],
    queryFn: async ({ pageParam = 1 }) => {
      const page = pageParam as number;
      if (online && options.onlineFetch) {
        try {
          return await options.onlineFetch(page, pageSize);
        } catch {
          // Network refresh failed — local source, else preserve stale cache.
          if (options.offlineFetch) return options.offlineFetch(page, pageSize);
          throw new Error("Offline — showing cached data");
        }
      }
      if (options.offlineFetch) return options.offlineFetch(page, pageSize);
      throw new Error("Offline — showing cached data");
    },
    initialPageParam: 1,
    getNextPageParam: nextPageParam,
    enabled,
    staleTime: options.staleTime ?? 30_000,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
  const data = query.data ? flattenPages<T>(query.data.pages as Array<{ data: T[] }>) : undefined;
  return { ...query, data };
}
