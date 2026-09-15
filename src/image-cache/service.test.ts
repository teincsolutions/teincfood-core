import { describe, it, expect, vi, beforeEach } from "vitest";
import { setFileSystemAdapter } from "../adapters/filesystem";
import {
  cacheRemoteImage,
  isDownloadableImageUrl,
  isLoadableImageUri,
  resolveImageSource,
  toRenderableUri,
  toStorableImageUrl,
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

describe("render gate (isLoadableImageUri / toRenderableUri)", () => {
  it("rejects the exact tfimg:// URI from the iOS crash report", () => {
    expect(isLoadableImageUri(TFIMG)).toBe(false);
    expect(toRenderableUri(TFIMG)).toBeNull();
  });

  it("rejects other non-renderable values (bare S3 keys, blob:)", () => {
    expect(toRenderableUri("menus/biz-1/photo.png")).toBeNull();
    expect(toRenderableUri("blob:http://localhost/abc")).toBeNull();
    expect(toRenderableUri(null)).toBeNull();
    expect(toRenderableUri(undefined)).toBeNull();
    expect(toRenderableUri("")).toBeNull();
  });

  it("passes through URIs RN <Image> can load", () => {
    for (const uri of [
      "https://cdn/x.jpg?sig=abc",
      "http://192.168.1.23:9000/b/k.jpg",
      "file:///doc/teincfood_images/ab.img",
      "data:image/png;base64,AAA",
      "asset:/bundle/icon.png",
    ]) {
      expect(isLoadableImageUri(uri)).toBe(true);
      expect(toRenderableUri(uri)).toBe(uri);
    }
  });

  it("toStorableImageUrl keeps S3 keys and http(s), nulls preview URIs", () => {
    expect(toStorableImageUrl("menus/biz-1/photo.png")).toBe("menus/biz-1/photo.png");
    expect(toStorableImageUrl("https://cdn/x.jpg")).toBe("https://cdn/x.jpg");
    expect(toStorableImageUrl(TFIMG)).toBeNull();
    expect(toStorableImageUrl("blob:http://localhost/abc")).toBeNull();
    expect(toStorableImageUrl("file:///doc/x.jpg")).toBeNull();
    expect(toStorableImageUrl("data:image/png;base64,AAA")).toBeNull();
    expect(toStorableImageUrl(null)).toBeNull();
    expect(toStorableImageUrl("")).toBeNull();
  });
});
