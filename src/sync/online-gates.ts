/**
 * Online-required allowlist — single source for what can NEVER work offline.
 *
 * Everything else is offline-first (SQLite read, local commit, engine sync).
 * These commands throw immediately when the cloud is unreachable: queuing
 * them would be dishonest because no transport (LAN or outbox replay) can
 * ever fulfill them without the backend.
 */

import { getConnectivityState } from "../adapters/connectivity";
import { TRANSITION_ERROR_CODES, TransitionError } from "./transition-errors";

/** Command types that require the cloud, unconditionally. */
export const ONLINE_REQUIRED: Record<string, string> = {
  "delivery:assign": "Assign rider requires online",
  "delivery:confirm_handover": "Handover confirmation requires online",
  // Aliases used by the domain/LAN action path (transitionLocalOrder).
  "order:assign_rider": "Assign rider requires online",
  "order:confirm_handover": "Handover confirmation requires online",
  "chat:send": "Chat requires online",
  "notification:register": "Notifications require online",
  "fleet:manage": "Fleet changes require online",
  "settings:manage": "Settings changes require online",
  "kyc:submit": "KYC submission requires online",
  "wallet:withdraw": "Withdrawals require online",
  "wallet:payout": "Payouts require online",
  "payment:charge_online": "Online payment requires online",
  "device:lease": "Device lease requires online (first lease only)",
  "subscription:manage": "Plan changes and checkout require online",
  "subscription:checkout": "Plan checkout requires online",
};

export function isOnlineCapable(): boolean {
  const s = getConnectivityState();
  return s.isOnline && s.isCloudReachable !== "unreachable";
}

/**
 * Throw when a command cannot proceed offline. Handles payload-dependent
 * cases: order:create with delivery type or prepaid/mobile-money payment,
 * and delivery/order transitions the domain already gates.
 */
export function assertOnlineFor(commandType: string, payload?: Record<string, unknown>): void {
  const fixed = ONLINE_REQUIRED[commandType];
  if (fixed) {
    if (!isOnlineCapable()) throw new TransitionError(TRANSITION_ERROR_CODES.ONLINE_REQUIRED, fixed);
    return;
  }
  if (commandType === "order:create" && payload) {
    const orderType = (payload as { order_type?: unknown }).order_type;
    if (orderType === "delivery" || (payload as { delivery_params?: unknown }).delivery_params) {
      if (!isOnlineCapable()) throw new TransitionError(TRANSITION_ERROR_CODES.ONLINE_REQUIRED, "Delivery orders require online");
      return;
    }
    const method = (payload as { pos_payment_method?: unknown }).pos_payment_method;
    if (typeof method === "string" && method !== "cash") {
      if (!isOnlineCapable()) throw new TransitionError(TRANSITION_ERROR_CODES.ONLINE_REQUIRED, "Online payment requires online — use cash while offline");
    }
  }
}

/**
 * Offline entitlement gate (fail-closed). Host apps evaluate the cached
 * signed envelope via `evaluateEntitlements` and pass `entitled` here for
 * gated commands (menu/member/promo/terminal/dispatch creation, online
 * orders). Expired, stale (> max_offline_days), or unverified => throw.
 * RBAC (`hasCapabilitySync`) stays fail-open (backend 403 backstop);
 * entitlements are the opposite: no proof => no access.
 */
export function assertEntitledFor(
  commandType: string,
  entitled: boolean,
  evaluationReason?: string,
): void {
  const gated = new Set([
    "order:create",
    "menu:create_item",
    "menu:update_item",
    "menu:delete_item",
    "menu:create_category",
    "promo:create",
    "member:invite",
    "member:manage",
    "terminal:link",
    "delivery:assign",
  ]);
  if (!gated.has(commandType)) return;
  if (!entitled) {
    throw new TransitionError(
      TRANSITION_ERROR_CODES.SUBSCRIPTION_REQUIRED,
      evaluationReason ?? "Subscription required — upgrade or reconnect to verify",
    );
  }
}
