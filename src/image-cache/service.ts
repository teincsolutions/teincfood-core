/**
 * Image cache for offline reference — port of Business src/reference/image-cache.ts
 * Durable documentDirectory cache (not cacheDirectory) with stable presigned URL keying.
 * Host injects FileSystemAdapter; falls back to no-op on web.
 */

import { getFileSystemAdapter } from "../adapters/filesystem";
import { syncLogger } from "../utils/sync-logger";

export interface ImageCacheEntry {
  remoteUrl: string;
  localUri: string | null;
  etag: string | null;
  lastModified: string | null;
  cachedAt: string | null;
}

export function stableCacheUrl(url: string): string {
  try { const p = new URL(url); return `${p.origin}${p.pathname}`; } catch { return url; }
}
function cacheKeyFromUrl(url: string): string {
  let hash = 0;
  const stable = stableCacheUrl(url);
  for (let i = 0; i < stable.length; i++) { hash = (hash << 5) - hash + stable.charCodeAt(i); hash |= 0; }
  return `${Math.abs(hash).toString(16)}.img`;
}
function getImageCacheDir(fs: ReturnType<typeof getFileSystemAdapter>): string {
  const base = fs?.getDocumentDirectory() ?? "";
  return `${base}teincfood_images/`;
}
export function getCachedImagePath(url: string): string {
  const fs = getFileSystemAdapter();
  return `${getImageCacheDir(fs)}${cacheKeyFromUrl(url)}`;
}
export async function ensureImageCacheDir(): Promise<string> {
  const fs = getFileSystemAdapter();
  if (!fs) return "";
  const dir = getImageCacheDir(fs);
  const info = await fs.getInfoAsync(dir);
  if (!info.exists) await fs.makeDirectoryAsync(dir, { intermediates: true });
  return dir;
}
export async function getCachedImageInfo(url: string): Promise<ImageCacheEntry> {
  const fs = getFileSystemAdapter();
  if (!fs) return { remoteUrl: url, localUri: url, etag: null, lastModified: null, cachedAt: new Date().toISOString() };
  const localPath = getCachedImagePath(url);
  const info = await fs.getInfoAsync(localPath);
  return { remoteUrl: url, localUri: info.exists && !info.isDirectory ? localPath : null, etag: null, lastModified: null, cachedAt: info.exists ? new Date().toISOString() : null };
}
const DOWNLOADABLE_RE = /^https?:\/\//i;

/**
 * Only http(s) URLs can be fetched by the host downloader. Anything else
 * (tfimg:// disk URIs leaked from another device, data:, blob:, file:)
 * is either already local or unfetchable — attempting a download throws
 * per-attempt errors (e.g. iOS NSURLError -1002) and, worse, feeds the
 * hook's warm-then-invalidate cycle into an unbounded retry storm.
 */
export function isDownloadableImageUrl(url: string): boolean {
  return DOWNLOADABLE_RE.test(url);
}

const LOADABLE_RE = /^(https?|file|data|asset|content):/i;

/**
 * URI schemes React Native's `<Image>` can actually load on device. Anything
 * else has no RCTImageURLLoader on iOS ("No suitable image URL loader
 * found") and crashes the screen — notably `tfimg://` disk URIs leaked from
 * desktop rows, bare S3 keys (`menus/biz/img.jpg`), and `blob:` preview
 * URLs. The hook maps these to null so callers render their placeholder
 * branch instead of feeding a fatal URI to the native loader.
 */
export function isLoadableImageUri(uri: string): boolean {
  return LOADABLE_RE.test(uri);
}

/** Map a resolved URI to one RN `<Image>` can load, else null (placeholder). */
export function toRenderableUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  return isLoadableImageUri(uri) ? uri : null;
}

const URI_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Values safe to persist as a menu image reference: S3 keys, http(s) URLs,
 * null. Preview URIs (tfimg:, blob:, file:, data:) must never be stored —
 * the backend keeps non-http values verbatim and they poison every other
 * device (mobile has no native loader for tfimg:// and crashes). Returns
 * null for un-storable values, so re-saving a poisoned row self-heals it
 * (caller re-uploads to restore the image).
 */
export function toStorableImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (URI_SCHEME_RE.test(value) && !DOWNLOADABLE_RE.test(value)) {
    syncLogger.warn("ImageCache", "Dropping un-storable image URL", { value: value.slice(0, 32) });
    return null;
  }
  return value;
}

export async function cacheRemoteImage(url: string | null | undefined, opts: { skipIfCached?: boolean; removeOnFailure?: boolean } = {}): Promise<ImageCacheEntry | null> {
  if (!url) return null;
  const fs = getFileSystemAdapter();
  if (!fs) return { remoteUrl: url, localUri: url, etag: null, lastModified: null, cachedAt: new Date().toISOString() };
  await ensureImageCacheDir();
  const localPath = getCachedImagePath(url);
  const existing = await fs.getInfoAsync(localPath);
  if (existing.exists && !existing.isDirectory) {
    return { remoteUrl: url, localUri: localPath, etag: null, lastModified: null, cachedAt: new Date().toISOString() };
  }
  if (!isDownloadableImageUrl(url)) {
    return { remoteUrl: url, localUri: null, etag: null, lastModified: null, cachedAt: null };
  }
  try {
    const res = await fs.downloadAsync(url, localPath);
    if (res.uri) return { remoteUrl: url, localUri: localPath, etag: null, lastModified: null, cachedAt: new Date().toISOString() };
  } catch (e) { syncLogger.warn("ImageCache", "Failed to download", { url, error: String(e) }); }
  if (opts.removeOnFailure) await fs.deleteAsync(localPath, { idempotent: true }).catch(() => {});
  return { remoteUrl: url, localUri: null, etag: null, lastModified: null, cachedAt: null };
}
export async function cacheImageBatch(urls: (string | null | undefined)[], opts: { skipIfCached?: boolean; removeOnFailure?: boolean } = {}): Promise<ImageCacheEntry[]> {
  const results = await Promise.all(urls.map((u) => cacheRemoteImage(u, opts)));
  return results.filter((r): r is ImageCacheEntry => r !== null);
}
export async function clearImageCache(): Promise<void> {
  const fs = getFileSystemAdapter();
  if (!fs) return;
  await fs.deleteAsync(getImageCacheDir(fs), { idempotent: true });
}
export async function pruneImageCache(knownUrls: Iterable<string | null | undefined>, maxAgeDays = 30): Promise<number> {
  try {
    const fs = getFileSystemAdapter();
    if (!fs) return 0;
    const known = new Set<string>();
    for (const u of knownUrls) if (u) known.add(u);
    const dir = getImageCacheDir(fs);
    const info = await fs.getInfoAsync(dir);
    if (!info.exists || info.isDirectory !== true) return 0;
    // cutoff check skipped without modificationTime — just orphan check
    const entries = await fs.readDirectoryAsync(dir);
    let pruned = 0;
    for (const f of entries) {
      if (!f.endsWith(".img")) continue;
      if ([...known].some((url) => getCachedImagePath(url) === `${dir}${f}`)) continue;
      await fs.deleteAsync(`${dir}${f}`, { idempotent: true });
      pruned += 1;
    }
    if (pruned > 0) syncLogger.info("ImageCache", "Pruned orphan images", { pruned });
    return pruned;
  } catch { return 0; }
}
export async function resolveImageSource(url: string | null | undefined): Promise<{ uri: string } | null> {
  if (!url) return null;
  const cached = await getCachedImageInfo(url);
  return cached.localUri ? { uri: cached.localUri } : { uri: url };
}
