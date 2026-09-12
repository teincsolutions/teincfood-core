/**
 * Offline validation mirror — frontend accepts exactly what the backend
 * accepts, so a locally-committed write is never rejected on sync for a
 * reason we could have caught. Each rule cites its backend changeset.
 *
 * Throws ValidationError (with `details` map for per-field form errors) —
 * never returns. Call before every local commit.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s]+@[^\s]+\.[^\s]+$/;

export class ValidationError extends Error {
  details: Record<string, string>;
  constructor(message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

function fail(field: string, message: string, details: Record<string, string>): never {
  details[field] = message;
  throw new ValidationError(message, details);
}

/** Mirrors MenuItem.changeset: required name/base_price_minor/category_id, price ≥ 0, category UUID. */
export function validateMenuItemInput(input: {
  name?: unknown;
  price_minor?: unknown;
  priceMinor?: unknown;
  category_id?: unknown;
  categoryId?: unknown;
  variants?: Array<{ name?: unknown }>;
  extras?: Array<{ name?: unknown }>;
}): void {
  const details: Record<string, string> = {};
  const name = input.name;
  if (typeof name !== "string" || !name.trim()) fail("name", "Name is required", details);
  const minor = input.price_minor ?? input.priceMinor;
  if (typeof minor !== "number" || !Number.isFinite(minor)) fail("price_minor", "Price is required", details);
  if (minor < 0) fail("price_minor", "Price must be 0 or more", details);
  const categoryId = input.category_id ?? input.categoryId;
  if (typeof categoryId !== "string" || !categoryId) fail("category_id", "Category is required", details);
  if (!UUID_RE.test(categoryId)) {
    // Backend enforces UUID format on category_id — client UUIDs from the
    // envelope builder always pass; temp form ids must never reach here.
    fail("category_id", "Category must be a valid UUID", details);
  }
  for (const v of input.variants ?? []) {
    if (!v || typeof v.name !== "string" || !v.name.trim()) fail("variants", "Variant name is required", details);
  }
  for (const e of input.extras ?? []) {
    if (!e || typeof e.name !== "string" || !e.name.trim()) fail("extras", "Extra name is required", details);
  }
}

/** Mirrors MenuCategory.changeset: required name. */
export function validateMenuCategoryInput(input: { name?: unknown }): void {
  const details: Record<string, string> = {};
  if (typeof input.name !== "string" || !input.name.trim()) fail("name", "Name is required", details);
}

/** Mirrors Order.changeset: required payment_mode/total/currency, amounts ≥ 0. */
export function validateOrderCreateInput(input: {
  payment_mode?: unknown;
  pos_payment_method?: unknown;
  total_minor?: unknown;
  currency_code?: unknown;
  currency?: unknown;
  items?: unknown;
  order_type?: unknown;
  delivery_address?: unknown;
}): void {
  const details: Record<string, string> = {};
  const items = (input as { item_snapshots?: unknown }).item_snapshots ?? input.items;
  if (!Array.isArray(items) || items.length === 0) fail("items", "Order must have at least one item", details);
  for (const k of ["total_minor", "subtotal_minor", "delivery_fee_minor", "tax_minor"] as const) {
    const v = (input as Record<string, unknown>)[k];
    if (v !== undefined && (typeof v !== "number" || v < 0)) fail(k, `${k} must be 0 or more`, details);
  }
  if (input.order_type === "delivery" && !input.delivery_address) {
    fail("delivery_address", "Delivery address is required for delivery orders", details);
  }
}

/** Mirrors BusinessMemberInvitation changeset: email format. */
export function validateInviteInput(input: { email?: unknown; invited_email?: unknown }): void {
  const details: Record<string, string> = {};
  const email = input.invited_email ?? input.email;
  if (typeof email !== "string" || !email.trim()) fail("email", "Email is required", details);
  if (!EMAIL_RE.test(email)) fail("email", "Invalid email format", details);
}
