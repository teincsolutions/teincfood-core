/**
 * Image cache stub — no-op in core library.
 * Host apps with file-system access inject real impl via imageCacheService.
 */

export const imageCacheService: {
  cacheImageBatch(urls: (string | null | undefined)[], opts?: { skipIfCached?: boolean }): Promise<string[]>;
  pruneImageCache(urls: (string | null | undefined)[]): Promise<void>;
} = {
  async cacheImageBatch() {
    return [];
  },
  async pruneImageCache() {},
};

export async function cacheImageBatch(
  urls: (string | null | undefined)[],
  opts?: { skipIfCached?: boolean },
): Promise<string[]> {
  return imageCacheService.cacheImageBatch(urls, opts);
}

export async function pruneImageCache(urls: (string | null | undefined)[]): Promise<void> {
  return imageCacheService.pruneImageCache(urls);
}
