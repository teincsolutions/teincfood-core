/**
 * Membership validation and revoked-access cleanup.
 *
 * Online-only by design: offline-first sessions remain valid for their full
 * configured offline license period. We only check membership when the client
 * is online (or when it reconnects), and we never impose a short membership
 * TTL on offline use.
 */

import { getHttpClient } from "../adapters/http";
import { deleteEntitySnapshotsForBusiness } from "../db/operations";
import { openSyncDatabase } from "../db/connection";
import { removeOfflineMember, clearOfflineDevice } from "../offline/store";
import { deleteReferenceDataForBusiness } from "../reference/operations";
import { syncLogger } from "../utils/sync-logger";

export interface BusinessMembershipValidation {
  business_id: string;
  role: string;
  source: string;
  status: string;
  capabilities: string[];
}

export class MembershipRevokedError extends Error {
  readonly businessId: string;
  readonly cause: unknown;

  constructor(businessId: string, cause?: unknown) {
    super(`Membership for business ${businessId} is no longer active`);
    this.name = "MembershipRevokedError";
    this.businessId = businessId;
    this.cause = cause;
  }
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export function isMembershipRevocationStatus(status: unknown): boolean {
  return status === 401 || status === 403 || status === 404;
}

export function isMembershipRevokedError(error: unknown): error is MembershipRevokedError {
  return error instanceof MembershipRevokedError;
}

/**
 * Confirms the signed-in user still has an active membership for `businessId`.
 * Any explicit auth/membership failure is surfaced as MembershipRevokedError;
 * transient network/server errors are left untouched so callers can retry.
 */
export async function validateBusinessMembership(
  businessId: string,
): Promise<BusinessMembershipValidation> {
  try {
    const response = await getHttpClient().get<{ data?: BusinessMembershipValidation }>(
      `/businesses/${encodeURIComponent(businessId)}/my-membership`,
    );
    const membership =
      (response as { data?: { data?: BusinessMembershipValidation } })?.data?.data ??
      (response as { data?: BusinessMembershipValidation })?.data;

    if (!membership?.business_id) {
      throw new Error("Malformed my-membership response");
    }
    if (membership.status && membership.status !== "active") {
      throw new MembershipRevokedError(businessId);
    }
    return membership;
  } catch (error) {
    if (error instanceof MembershipRevokedError) throw error;
    if (isMembershipRevocationStatus(statusOf(error))) {
      throw new MembershipRevokedError(businessId, error);
    }
    throw error;
  }
}

export interface ClearRevokedBusinessAccessOptions {
  businessId: string;
  userId: string;
  /** Clear the local device license as well (use on the removed member's device). */
  clearDeviceLicense?: boolean;
}

/**
 * Wipes everything that would let a removed member keep working offline.
 * Queued transactional data (orders/sync_jobs) is intentionally retained.
 */
export async function clearRevokedBusinessAccess({
  businessId,
  userId,
  clearDeviceLicense = false,
}: ClearRevokedBusinessAccessOptions): Promise<void> {
  try {
    await removeOfflineMember(userId, businessId);
  } catch (error) {
    syncLogger.warn("Membership", "Failed to remove offline member credential", {
      businessId,
      userId,
      error: String(error),
    });
  }

  if (clearDeviceLicense) {
    try {
      await clearOfflineDevice(businessId);
    } catch (error) {
      syncLogger.warn("Membership", "Failed to clear local device license", {
        businessId,
        error: String(error),
      });
    }
  }

  try {
    const db = await openSyncDatabase();
    await deleteReferenceDataForBusiness(db, businessId);
    await deleteEntitySnapshotsForBusiness(db, businessId);
  } catch (error) {
    syncLogger.warn("Membership", "Failed to delete cached business data", {
      businessId,
      error: String(error),
    });
  }
}
