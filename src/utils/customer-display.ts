/**
 * Customer display helpers — offline-first, shared by mobile + desktop.
 * SellerOrder shape comes from backend order_serializer (customer_name, is_pos, user{full_name, avatar_url, phone}).
 */

import type { SellerOrder } from "../types/api/seller.api";

export type CustomerDisplay = {
  name: string;
  avatarUrl: string | null;
  phone: string | null;
  isWalkIn: boolean;
  tellerName?: string | null;
};

type OrderLike = Pick<SellerOrder, "customer_name"> & {
  user?: { full_name?: string; avatar_url?: string; phone?: string } | null;
  customer?: {
    name?: string | null;
    phone?: string | null;
    avatar_url?: string | null;
  } | null;
  teller?: { full_name?: string | null } | null;
  customer_phone?: string | null;
  is_pos?: boolean;
};

/**
 * Single source of truth for customer identity.
 * - is_pos:true (POS walk-in): customer is walk-in/typed name, never the staff user.
 *   Staff is the teller (order.user) — do not show staff avatar as customer.
 *   Returns tellerName so UI can optionally show "Teller: <name>" underneath.
 * - is_pos:false (WhatsApp / online / AI agent): customer_name || user.full_name || "Customer" + avatar from user.avatar_url
 */
export function getCustomerDisplay(order: OrderLike): CustomerDisplay {
  if (order.is_pos) {
    const typedName =
      order.customer?.name?.trim() || order.customer_name?.trim();
    return {
      name: typedName || "Walk-in",
      avatarUrl: null,
      phone: order.customer?.phone ?? order.customer_phone ?? null,
      isWalkIn: true,
      tellerName:
        order.teller?.full_name?.trim() ??
        order.user?.full_name?.trim() ??
        null,
    };
  }
  const rawName =
    order.customer?.name?.trim() ||
    order.customer_name?.trim() ||
    order.user?.full_name?.trim() ||
    "";
  if (rawName) {
    return {
      name: rawName,
      avatarUrl: order.customer?.avatar_url ?? order.user?.avatar_url ?? null,
      phone:
        order.customer?.phone ??
        order.customer_phone ??
        order.user?.phone ??
        null,
      isWalkIn: false,
    };
  }
  return {
    name: "Customer",
    avatarUrl: order.customer?.avatar_url ?? order.user?.avatar_url ?? null,
    phone:
      order.customer?.phone ??
      order.customer_phone ??
      order.user?.phone ??
      null,
    isWalkIn: false,
  };
}

export function getCustomerSearchKeys(order: OrderLike): string[] {
  return [
    order.customer_name ?? "",
    order.user?.full_name ?? "",
    order.customer_phone ?? "",
    order.user?.phone ?? "",
    order.user?.avatar_url ?? "",
  ];
}

export function matchesCustomerSearch(
  order: OrderLike,
  qLower: string,
): boolean {
  if (!qLower) return true;
  const hay =
    `${order.customer_name ?? ""} ${order.user?.full_name ?? ""} ${order.customer_phone ?? ""} ${order.user?.phone ?? ""}`.toLowerCase();
  return hay.includes(qLower);
}
