import {
  hasCachedImage as hasCachedImageWithFileSystem,
  cacheImageFromBase64 as cacheImageFromBase64WithFileSystem,
} from "../image-cache/service";

/**
 * Image cache stub — no-op in core library.
 * Host apps with file-system access inject real impl via imageCacheService.
 */

export const imageCacheService: {
  cacheImageBatch(urls: (string | null | undefined)[], opts?: { skipIfCached?: boolean }): Promise<string[]>;
  pruneImageCache(urls: (string | null | undefined)[]): Promise<void>;
  hasCachedImage?(url: string | null | undefined): Promise<boolean>;
  cacheImageFromBase64?(url: string | null | undefined, base64: string | null | undefined): Promise<boolean>;
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

export async function hasCachedImage(url: string | null | undefined): Promise<boolean> {
  if (imageCacheService.hasCachedImage) return imageCacheService.hasCachedImage(url);
  return hasCachedImageWithFileSystem(url);
}

export async function cacheImageFromBase64(
  url: string | null | undefined,
  base64: string | null | undefined,
): Promise<boolean> {
  if (imageCacheService.cacheImageFromBase64) {
    return imageCacheService.cacheImageFromBase64(url, base64);
  }
  return cacheImageFromBase64WithFileSystem(url, base64);
}
