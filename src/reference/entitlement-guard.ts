/**
 * Offline entitlement auto-guard — evaluates the cached signed
 * `subscription:entitlements` envelope and enforces gated commands locally,
 * before any transport is attempted. The backend remains the final authority
 * (HTTP 402 SUBSCRIPTION_REQUIRED); this guard gives immediate feedback and
 * keeps disallowed work out of the outbox.
 *
 * Fail-closed: missing envelope, missing secret, bad signature, expired, or
 * stale (> max_offline_days) => gated commands throw SUBSCRIPTION_REQUIRED.
 * The host app provisions the HMAC secret at boot via setEntitlementSecret
 * and refreshes the envelope via reference sync; useEntitlements surfaces
 * mustReconnect/paywall state for UI gates.
 */

import { openSyncDatabase } from "../db/connection";
import { getReferenceData } from "../reference/operations";
import {
  evaluateEntitlements,
  getEntitledFeature,
  type EntitlementEvaluation,
} from "./entitlements";
import { assertEntitledFor } from "../sync/online-gates";
import type { ReferenceDataKey } from "./types";

let entitlementSecret: string | null = null;

/** Provisioned once at app boot from the host app's env. */
export function setEntitlementSecret(secret: string | null): void {
  entitlementSecret = secret;
}

export function getEntitlementSecret(): string | null {
  return entitlementSecret;
}

export interface BusinessEntitlementState {
  evaluation: EntitlementEvaluation;
  features: Record<string, unknown> | null;
}

/** Evaluate the cached signed envelope for a business (no network). */
export async function evaluateBusinessEntitlements(
  businessId: string,
): Promise<BusinessEntitlementState> {
  const db = await openSyncDatabase();
  const rec = await getReferenceData<{ data?: unknown; envelope?: never }>(
    db,
    businessId,
    "subscription:entitlements" as ReferenceDataKey,
  );
  const payload = (rec?.payload ?? null) as {
    data?: Record<string, unknown>;
    envelope?: Parameters<typeof evaluateEntitlements>[0]["envelope"];
  } | null;
  const evaluation = await evaluateEntitlements({
    businessId,
    envelope: payload?.envelope,
    features: payload?.data,
    secret: entitlementSecret ?? "",
  });
  return { evaluation, features: payload?.data ?? null };
}

/**
 * Per-command feature keys. Commands without an entry require overall
 * `entitled` only (counts/quotas stay backend-enforced). delivery:assign is
 * intentionally overall-only: merchants assigning their own riders are not
 * subject to the fleet feature (backend scopes fleet.dispatch to
 * delivery_provider businesses the same way).
 */
const FEATURE_BY_COMMAND: Record<string, string> = {
  "promo:create": "seller.promo",
};

/** Real engine command types subject to the entitlement guard. */
const GATED_COMMANDS = new Set([
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

export function isEntitlementGated(commandType: string): boolean {
  return GATED_COMMANDS.has(commandType);
}

/**
 * Throw SUBSCRIPTION_REQUIRED unless the cached entitlement proof covers
 * this command. No-ops for non-gated commands — and when no envelope was
 * ever cached (fresh terminal that never synced): the backend remains the
 * authority there. Once proof exists, invalid/expired/stale proof denies.
 */
export async function assertEntitledForCommand(
  businessId: string,
  commandType: string,
): Promise<void> {
  if (!isEntitlementGated(commandType)) return;
  const db = await openSyncDatabase();
  const rec = await getReferenceData(db, businessId, "subscription:entitlements" as ReferenceDataKey);
  if (!rec?.payload) return;
  const { evaluation, features } = await evaluateBusinessEntitlements(businessId);
  const feature = FEATURE_BY_COMMAND[commandType];
  const entitled =
    evaluation.entitled &&
    (!feature || getEntitledFeature(evaluation, features, feature));
  assertEntitledFor(commandType, entitled, evaluation.reason);
}
