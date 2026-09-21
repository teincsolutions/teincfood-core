import { describe, it, expect } from "vitest";
import { buildMenuItemEnvelope, imageUrlForUpdateWire } from "./menu-record";

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
    const { wire, cacheRecord } = buildMenuItemEnvelope({
      ...baseInput(),
      variants: [{ id: UUID, name: "Large", price: 6000 }],
      extras: [{ id: UUID, name: "Egg", price_minor: 200 }],
    });
    expect(wire.variants).toEqual([{ id: UUID, name: "Large", price: 6000 }]);
    expect(wire.extras).toEqual([{ id: UUID, name: "Egg", price_minor: 200 }]);
    // Cache record holds the absolute backend-shaped price.
    expect(cacheRecord.variants?.[0]?.price?.amountMinor).toBe(6000);
  });

  it("passes client-generated UUIDs through so the backend stores them verbatim", () => {
    const clientVariant = "6f8d2c1a-3b4e-4f5a-9c6d-7e8f0a1b2c3d";
    const clientExtra = "7a9e3d2b-4c5f-4a6b-8d7e-9f0a1b2c3d4e";
    const { wire } = buildMenuItemEnvelope({
      ...baseInput(),
      variants: [{ id: clientVariant, name: "Large", price: 6000 }],
      extras: [{ id: clientExtra, name: "Egg", price_minor: 200 }],
    });
    expect(wire.variants).toEqual([{ id: clientVariant, name: "Large", price: 6000 }]);
    expect(wire.extras).toEqual([{ id: clientExtra, name: "Egg", price_minor: 200 }]);
  });

  it("omits non-UUID junk ids so the backend inserts new rows instead of raising", () => {
    const { wire } = buildMenuItemEnvelope({
      ...baseInput(),
      variants: [{ id: "not-a-uuid", name: "Large", price: 6000 }],
      extras: [{ id: "not-a-uuid", name: "Egg", price_minor: 200 }],
    });
    expect(wire.variants).toEqual([{ name: "Large", price: 6000 }]);
    expect(wire.extras).toEqual([{ name: "Egg", price_minor: 200 }]);
  });

  it("defaults a priceless variant to the base price", () => {
    const { wire, cacheRecord } = buildMenuItemEnvelope({
      ...baseInput(),
      variants: [{ name: "Regular" }],
    });
    expect(wire.variants).toEqual([{ name: "Regular", price: 5000 }]);
    expect(cacheRecord.variants?.[0]?.price?.amountMinor).toBe(5000);
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

describe("imageUrlForUpdateWire", () => {
  it("sends the fresh S3 key after a new upload", () => {
    expect(
      imageUrlForUpdateWire({ freshKey: "menus/biz/123-abc-photo.jpg", loadedUrl: "https://cdn/old.jpg?sig=x", hadImage: true }),
    ).toBe("menus/biz/123-abc-photo.jpg");
  });

  it("omits image_url on plain edits so the server key is preserved", () => {
    expect(
      imageUrlForUpdateWire({ loadedUrl: "https://cdn/old.jpg?sig=x", hadImage: true }),
    ).toBeUndefined();
    expect(
      imageUrlForUpdateWire({ loadedUrl: "menus/biz/123-abc-photo.jpg", hadImage: true }),
    ).toBeUndefined();
  });

  it("sends explicit null when the user removed the photo", () => {
    expect(imageUrlForUpdateWire({ loadedUrl: "", hadImage: true })).toBeNull();
    expect(imageUrlForUpdateWire({ loadedUrl: null, hadImage: true })).toBeNull();
  });

  it("omits when there never was a photo", () => {
    expect(imageUrlForUpdateWire({ loadedUrl: "", hadImage: false })).toBeUndefined();
    expect(imageUrlForUpdateWire({ loadedUrl: null, hadImage: false })).toBeUndefined();
  });

  it("nulls poisoned tfimg URIs so stored rows heal", () => {
    expect(
      imageUrlForUpdateWire({ loadedUrl: "tfimg://localhost/abc123.jpg", hadImage: true }),
    ).toBeNull();
  });
});
