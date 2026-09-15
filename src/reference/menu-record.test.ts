import { describe, it, expect } from "vitest";
import { buildMenuItemEnvelope } from "./menu-record";

const UUID = "0f0764da-53aa-48e4-ac40-3bfd8a52b0ec";

function baseInput() {
  return {
    businessId: "biz-1",
    name: "Jollof",
    priceMinor: 5000,
    categoryId: "cat-1",
  };
}

describe("buildMenuItemEnvelope wire ids", () => {
  it("preserves backend UUID variant/extra ids so update does not wipe them", () => {
    const { wire } = buildMenuItemEnvelope({
      ...baseInput(),
      variants: [{ id: UUID, name: "Large", price_adjustment: 1000 }],
      extras: [{ id: UUID, name: "Egg", price_minor: 200 }],
    });
    expect(wire.variants).toEqual([{ id: UUID, name: "Large", price_adjustment: 1000 }]);
    expect(wire.extras).toEqual([{ id: UUID, name: "Egg", price_minor: 200 }]);
  });

  it("omits form-local ids so the backend inserts new rows instead of raising", () => {
    const { wire } = buildMenuItemEnvelope({
      ...baseInput(),
      variants: [{ id: "local-1757846400000", name: "Large", price_adjustment: 1000 }],
      extras: [{ id: "local-1757846400001", name: "Egg", price_minor: 200 }],
    });
    expect(wire.variants).toEqual([{ name: "Large", price_adjustment: 1000 }]);
    expect(wire.extras).toEqual([{ name: "Egg", price_minor: 200 }]);
  });

  it("passes image_url (S3 key) through to the wire", () => {
    const { wire, cacheRecord } = buildMenuItemEnvelope({
      ...baseInput(),
      imageUrl: "menus/biz-1/photo.png",
    });
    expect(wire.image_url).toBe("menus/biz-1/photo.png");
    expect(cacheRecord.image_url).toBe("menus/biz-1/photo.png");
  });

  it("passes https image URLs through", () => {
    const { wire, cacheRecord } = buildMenuItemEnvelope({
      ...baseInput(),
      imageUrl: "https://cdn/x.jpg?sig=abc",
    });
    expect(wire.image_url).toBe("https://cdn/x.jpg?sig=abc");
    expect(cacheRecord.image_url).toBe("https://cdn/x.jpg?sig=abc");
  });

  it("nulls tfimg:// preview URIs so poisoned rows self-heal on re-save", () => {
    const { wire, cacheRecord } = buildMenuItemEnvelope({
      ...baseInput(),
      imageUrl:
        "tfimg://localhost/ae87c2aa28ed8ca83c76482fd3962b36106a1f0641853681f6c8bbe3b2f334fb.jpg",
    });
    expect(wire.image_url).toBeNull();
    expect(cacheRecord.image_url).toBeNull();
  });

  it("nulls blob:/file:/data: preview URIs", () => {
    for (const imageUrl of [
      "blob:http://localhost/abc",
      "file:///doc/x.jpg",
      "data:image/png;base64,AAA",
    ]) {
      const { wire, cacheRecord } = buildMenuItemEnvelope({ ...baseInput(), imageUrl });
      expect(wire.image_url).toBeNull();
      expect(cacheRecord.image_url).toBeNull();
    }
  });
});
