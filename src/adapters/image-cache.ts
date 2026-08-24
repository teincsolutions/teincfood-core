/**
 * Image cache stub — no-op in core library.
 * Host apps with file-system access inject real impl.
 */

export async function cacheImageBatch(
  _urls: (string | null | undefined)[],
  _opts?: { skipIfCached?: boolean },
): Promise<string[]> {
  return [];
}

export async function pruneImageCache(_urls: (string | null | undefined)[]): Promise<void> {}
