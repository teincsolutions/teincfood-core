import { describe, it, expect, vi, beforeEach } from "vitest";
import { setFileSystemAdapter } from "../adapters/filesystem";
import {
  cacheRemoteImage,
  isDownloadableImageUrl,
  resolveImageSource,
} from "./service";

const TFIMG =
  "tfimg://localhost/ae87c2aa28ed8ca83c76482fd3962b36106a1f0641853681f6c8bbe3b2f334fb.jpg";

describe("image-cache non-http URLs (tfimg leak hardening)", () => {
  const downloadAsync = vi.fn(async (_url: string, _file: string) => ({ uri: _file }));
  const getInfoAsync = vi.fn(async (_path: string) => ({ exists: false }));

  beforeEach(() => {
    vi.clearAllMocks();
    getInfoAsync.mockImplementation(async () => ({ exists: false }));
    setFileSystemAdapter({
      getInfoAsync,
      makeDirectoryAsync: async () => undefined,
      downloadAsync,
      deleteAsync: async () => undefined,
      readDirectoryAsync: async () => [],
      getDocumentDirectory: () => "/doc/",
    });
  });

  it("classifies schemes", () => {
    expect(isDownloadableImageUrl("https://cdn/x.jpg?sig=abc")).toBe(true);
    expect(isDownloadableImageUrl("http://minio:9000/b/k.jpg")).toBe(true);
    expect(isDownloadableImageUrl(TFIMG)).toBe(false);
    expect(isDownloadableImageUrl("data:image/png;base64,AAA")).toBe(false);
    expect(isDownloadableImageUrl("file:///doc/x.jpg")).toBe(false);
    expect(isDownloadableImageUrl("menus/biz/img.jpg")).toBe(false);
  });

  it("never attempts to download a tfimg:// URI (iOS NSURLError -1002 storm)", async () => {
    const res = await cacheRemoteImage(TFIMG, { skipIfCached: true });
    expect(downloadAsync).not.toHaveBeenCalled();
    expect(res?.localUri).toBeNull();
  });

  it("resolveImageSource passes tfimg through without downloading", async () => {
    const res = await resolveImageSource(TFIMG);
    expect(downloadAsync).not.toHaveBeenCalled();
    expect(res).toEqual({ uri: TFIMG });
  });

  it("still downloads http(s) URLs on cache miss", async () => {
    downloadAsync.mockResolvedValue({ uri: "/doc/teincfood_images/ab.img" });
    const res = await cacheRemoteImage("https://cdn/x.jpg", { skipIfCached: true });
    expect(downloadAsync).toHaveBeenCalledTimes(1);
    expect(res?.localUri).toContain("teincfood_images/");
  });

  it("returns existing cache without downloading (any scheme)", async () => {
    getInfoAsync.mockImplementation(async (p: string) =>
      p.endsWith("teincfood_images/") ? { exists: true } : { exists: true },
    );
    const res = await cacheRemoteImage(TFIMG, { skipIfCached: true });
    expect(downloadAsync).not.toHaveBeenCalled();
    expect(res?.localUri).toContain("teincfood_images/");
  });
});
