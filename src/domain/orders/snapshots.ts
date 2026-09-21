import type { OrderItem } from "../../types/api/seller.api";

/**
 * Order Item Snapshots — the single contract for sale-time history.
 *
 * Every order line carries its own immutable snapshot (item/variant/addon
 * names as of sale time) so order history never depends on the live menu:
 * sizes, extras, and items can be renamed or deleted without touching past
 * orders — on any client, online or offline.
 *
 * Both POS apps build their outbox payloads through `buildItemSnapshots`:
 * it accepts either app's cart-line shape (rich lines with
 * `selected_variant`/`selected_addons`, or thin lines with just the menu
 * item) plus already-built snapshots (idempotent), and always emits the
 * full canonical shape. The local order builders and the offline receipt
 * renderer consume only this shape — they never re-resolve names from the
 * menu cache.
 */

export interface SnapshotAddon {
  name: string;
  price_minor: number;
}

export interface OrderItemSnapshot {
  menu_item_id: string;
  name: string;
  quantity: number;
  unit_price_minor: number;
  variant_id?: string;
  variant_name?: string;
  addons: SnapshotAddon[];
}

/** Cart line shapes from the POS apps (superset tolerated). */
export interface SnapshotCartLine {
  menu_item?: { id: string; name: string } | null;
  menu_item_id?: string;
  name?: string;
  quantity?: number;
  unit_price_minor?: number;
  unit_price?: number;
  subtotal?: number;
  selected_variant?: { id?: string; name?: string } | null;
  variant_id?: string;
  variant_name?: string;
  selected_addons?: Array<{
    addon_id?: string;
    id?: string;
    name?: string;
    price_minor?: number;
    price?: number;
  }> | null;
  addons?: Array<{ name?: string; price_minor?: number; price?: number }> | null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Normalize any POS cart line (or an already-built snapshot) into the
 * canonical snapshot. Missing variant/addon info yields `undefined` / `[]`
 * — never a menu-cache lookup.
 */
export function buildItemSnapshots(lines: SnapshotCartLine[] | null | undefined): OrderItemSnapshot[] {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => {
    const menuItemId = asString(line.menu_item?.id ?? line.menu_item_id);
    const name = asString(line.menu_item?.name ?? line.name);
    const quantity = asNumber(line.quantity, 1);
    const unitPrice = asNumber(
      line.unit_price_minor ?? line.unit_price,
      0,
    );
    const subtotal = asNumber(line.subtotal, unitPrice * quantity);

    const variantId = line.selected_variant?.id ?? line.variant_id;
    const variantName = line.selected_variant?.name ?? line.variant_name;

    const rawAddons = line.selected_addons ?? line.addons ?? [];
    const addons: SnapshotAddon[] = Array.isArray(rawAddons)
      ? rawAddons.map((a) => ({
          name: asString(a.name),
          price_minor: asNumber(a.price_minor ?? a.price, 0),
        }))
      : [];

    const explicitPrice = line.unit_price_minor ?? line.unit_price;
    const unitPriceMinor =
      typeof explicitPrice === "number" && Number.isFinite(explicitPrice)
        ? explicitPrice
        : subtotal && quantity
          ? Math.round(subtotal / quantity)
          : 0;

    const snapshot: OrderItemSnapshot = {
      menu_item_id: menuItemId,
      name,
      quantity,
      unit_price_minor: unitPriceMinor,
      addons,
    };
    if (variantId) snapshot.variant_id = variantId;
    if (typeof variantName === "string" && variantName !== "") snapshot.variant_name = variantName;
    return snapshot;
  });
}

/**
 * Expand snapshots into local order-line objects (the `SellerOrder["items"]`
 * shape): names embedded, ids kept for reference, zero menu lookups.
 */
export function snapshotsToOrderLines(
  snapshots: OrderItemSnapshot[] | null | undefined,
  commandId: string,
): OrderItem[] {
  if (!Array.isArray(snapshots)) return [];
  return snapshots.map((s, index) => ({
    id: `tmp-${commandId}-${index}`,
    menu_item: { id: s.menu_item_id, name: s.name },
    quantity: s.quantity,
    unit_price: s.unit_price_minor,
    subtotal: s.unit_price_minor * s.quantity,
    variant_id: s.variant_id ?? null,
    variant_name: s.variant_name ?? null,
    variant: s.variant_name ? { id: s.variant_id, name: s.variant_name } : null,
    addons: (s.addons ?? []).map((a) => ({ name: a.name, price_minor: a.price_minor })),
  })) as unknown as OrderItem[];
}
