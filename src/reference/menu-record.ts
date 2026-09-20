/**
 * Menu cache-record builders — the ONLY place MenuItem/MenuCategory records
 * are constructed outside the backend.
 *
 * The reference cache holds backend-shaped records exactly as the serializer
 * returns them (see TeincFoodBackend menu_serializer.ex). Form/mutation
 * layers own every field at write time, so they build the record here —
 * core never translates wire payloads into cache records.
 */

import { generateUUID } from "../utils/uuid";
import type { MenuCategory, MenuItem } from "../types/api/menu.api";
import type { QueryClient } from "@tanstack/react-query";
import { CATALOG_KEYS } from "../catalog/hooks";
import { toStorableImageUrl } from "../image-cache/service";

export interface MenuItemRecordInput {
  id?: string;
  businessId: string;
  name: string;
  description?: string | null;
  priceMinor: number;
  currencyCode?: string;
  categoryId: string;
  categoryName?: string;
  dietaryTags?: string[];
  variants?: Array<{ id?: string; name: string; price?: number }>;
  extras?: Array<{ id?: string; name: string; price_minor?: number }>;
  available?: boolean;
  imageUrl?: string | null;
  now?: string;
}

export function buildMenuItemRecord(input: MenuItemRecordInput): MenuItem {
  const currencyCode = input.currencyCode || "GHS";
  const now = input.now ?? new Date().toISOString();
  return {
    id: input.id ?? generateUUID(),
    name: input.name,
    description: input.description ?? null,
    basePrice: { amountMinor: input.priceMinor, currencyCode },
    // Never persist preview URIs (tfimg:/blob:/file:): the backend stores
    // non-http values verbatim and they poison every other device.
    image_url: toStorableImageUrl(input.imageUrl),
    is_available: input.available ?? true,
    dietary_tags: input.dietaryTags ?? [],
    category_id: input.categoryId,
    business_id: input.businessId,
    category: { id: input.categoryId, name: input.categoryName ?? "" },
    variants: (input.variants ?? []).map((v) => ({
      id: v.id ?? generateUUID(),
      name: v.name,
      // Absolute variant price (backend model) — no size defaults to base.
      price: { amountMinor: v.price ?? input.priceMinor, currencyCode },
    })),
    extras: (input.extras ?? []).map((e) => ({
      id: e.id ?? generateUUID(),
      name: e.name,
      pricingType: "fixed",
      amountMinor: e.price_minor ?? 0,
      currencyCode,
    })),
    inserted_at: now,
    updated_at: now,
  };
}

export interface MenuCategoryRecordInput {
  id?: string;
  name: string;
  sort_order?: number;
}

export function buildMenuCategoryRecord(input: MenuCategoryRecordInput): MenuCategory {
  return {
    id: input.id ?? generateUUID(),
    name: input.name,
    sort_order: input.sort_order ?? 0,
    is_global: false,
    is_system: false,
    pending_global_request: false,
  };
}

// ─── Cache lookups (mutation layers read current records to build envelopes)

function collectItems(blob: unknown, out: MenuItem[]): void {
  if (!blob || typeof blob !== "object") return;
  if (Array.isArray(blob)) {
    for (const i of blob) if ((i as MenuItem)?.id) out.push(i as MenuItem);
    return;
  }
  const rec = blob as { data?: unknown; pages?: Array<{ data?: unknown }> };
  if (Array.isArray(rec.data)) collectItems(rec.data, out);
  if (Array.isArray(rec.pages)) for (const p of rec.pages) collectItems(p?.data, out);
}

/** Every cached MenuItem for a business across cached + network queries. */
export function getCachedMenuItems(qc: QueryClient, businessId: string): MenuItem[] {
  const out: MenuItem[] = [];
  try {
    for (const [, data] of qc.getQueriesData({ queryKey: CATALOG_KEYS.items(businessId) })) {
      collectItems(data, out);
    }
  } catch {}
  const seen = new Set<string>();
  return out.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

export function getCachedMenuItem(qc: QueryClient, businessId: string, id: string): MenuItem | undefined {
  return getCachedMenuItems(qc, businessId).find((i) => i.id === id);
}

function collectCategories(blob: unknown, out: MenuCategory[]): void {
  if (!blob || typeof blob !== "object") return;
  if (Array.isArray(blob)) {
    for (const c of blob) if ((c as MenuCategory)?.id) out.push(c as MenuCategory);
    return;
  }
  const rec = blob as { data?: unknown };
  if (Array.isArray(rec.data)) collectCategories(rec.data, out);
}

export function getCachedCategories(qc: QueryClient, businessId: string): MenuCategory[] {
  const out: MenuCategory[] = [];
  try {
    for (const [, data] of qc.getQueriesData({ queryKey: CATALOG_KEYS.categories(businessId) })) {
      collectCategories(data, out);
    }
  } catch {}
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
}

export function getCachedCategoryName(qc: QueryClient, businessId: string, categoryId: string): string {
  return getCachedCategories(qc, businessId).find((c) => c.id === categoryId)?.name ?? "";
}

// ─── Command envelopes (wire + cache record, built together) ───

export interface MenuItemEnvelopeInput extends MenuItemRecordInput {
  /** Extra wire-only keys (e.g. entity id). */
  wireExtra?: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A variant/extra id is only safe to send when it is a real backend UUID.
 * Form-local ids (e.g. `local-<ts>`) must be omitted: the backend treats a
 * missing/empty id as "insert new", but Repo.get/3 raises on a non-UUID.
 */
function wireId(id: string | undefined): string | undefined {
  return id && UUID_RE.test(id) ? id : undefined;
}

/**
 * Build the { wire, cacheRecord } pair for a menu item write. Callers pass
 * absolute variant prices (backend model) — the form layer owns the field.
 *
 * Variant/extra ids are preserved when they are backend UUIDs. The backend
 * update path deletes existing rows absent from the incoming list, so
 * stripping ids on edit would wipe + recreate every variant/extra on each
 * save (breaking any external references to those ids).
 */
export function buildMenuItemEnvelope(input: MenuItemEnvelopeInput): {
  wire: Record<string, unknown>;
  cacheRecord: MenuItem;
} {
  const id = input.id ?? generateUUID();
  const cacheRecord = buildMenuItemRecord({ ...input, id });
  const wire: Record<string, unknown> = {
    id,
    name: input.name,
    description: input.description ?? "",
    price_minor: input.priceMinor,
    category_id: input.categoryId,
    currency_code: input.currencyCode ?? "GHS",
    dietary_tags: input.dietaryTags ?? [],
    variants: (input.variants ?? []).map((v) => {
      const vid = wireId(v.id);
      return vid
        ? { id: vid, name: v.name, price: v.price ?? input.priceMinor }
        : { name: v.name, price: v.price ?? input.priceMinor };
    }),
    extras: (input.extras ?? []).map((e) => {
      const eid = wireId(e.id);
      return eid
        ? { id: eid, name: e.name, price_minor: e.price_minor ?? 0 }
        : { name: e.name, price_minor: e.price_minor ?? 0 };
    }),
    available: input.available ?? true,
    // Same storable rule as the cache record: preview URIs must not reach
    // the backend (it stores them verbatim).
    image_url: toStorableImageUrl(input.imageUrl),
    ...(input.wireExtra ?? {}),
  };
  return { wire, cacheRecord };
}

export function buildMenuCategoryEnvelope(input: MenuCategoryRecordInput): {
  wire: Record<string, unknown>;
  cacheRecord: MenuCategory;
} {
  const cacheRecord = buildMenuCategoryRecord(input);
  return { wire: { id: cacheRecord.id, name: input.name, ...(input.sort_order !== undefined ? { sort_order: input.sort_order } : {}) }, cacheRecord };
}
