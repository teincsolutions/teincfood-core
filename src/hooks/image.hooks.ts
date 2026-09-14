/**
 * Offline-first image source resolution — single source for both apps.
 *
 * Returns the durable local file path when cached, otherwise the remote URL.
 * While online, uncached images warm in the background. Falls back to remote
 * so online behavior is unchanged.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { getConnectivityState, subscribeConnectivity } from "../adapters/connectivity";
import { cacheRemoteImage, getCachedImageInfo, resolveImageSource, stableCacheUrl } from "../image-cache/service";

export const IMAGE_CACHE_KEYS = {
  all: ["cachedImage"] as const,
  url: (url: string) => ["cachedImage", url] as const,
};

export const CACHED_IMAGE_KEYS = IMAGE_CACHE_KEYS;

/** Invalidate every cached-image query (e.g. after a bulk reference sync). */
export function invalidateCachedImages(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: IMAGE_CACHE_KEYS.all });
}

/** Resolve an image URL to a URI. Prefers local cache; null for null URL. */
export function useCachedImageUrl(url: string | null | undefined): string | null {
  const queryClient = useQueryClient();
  const connectivity = useSyncExternalStore(subscribeConnectivity, getConnectivityState, getConnectivityState);
  const isOnline = connectivity.isOnline;
  const enabled = Boolean(url);

  const { data } = useQuery({
    queryKey: IMAGE_CACHE_KEYS.url(stableCacheUrl(url ?? "__none__")),
    queryFn: async () => {
      if (!url) return null;
      const resolved = await resolveImageSource(url);
      if (!resolved) return { uri: url };
      if (resolved.uri === url && isOnline) {
        // Warm in the background, but refresh this query ONLY if warming
        // actually landed the file. Unconditional invalidate-after-warm
        // turns every permanent failure (offline race, unfetchable URL)
        // into an unbounded refetch → warm → fail loop.
        cacheRemoteImage(url, { skipIfCached: true })
          .then(async () => {
            try {
              const fresh = await getCachedImageInfo(url);
              if (fresh.localUri) {
                queryClient.invalidateQueries({ queryKey: IMAGE_CACHE_KEYS.url(stableCacheUrl(url)) });
              }
            } catch {}
          })
          .catch(() => {});
      }
      return resolved;
    },
    enabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
    networkMode: "offlineFirst" as const,
  });

  if (!enabled || !data) return null;
  return (data as { uri: string }).uri;
}
