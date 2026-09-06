/**
 * Business open/closed evaluation — single source for the lib.
 *
 * Mirrors backend `TeincFoodBackend.Businesses.is_open?/1` exactly:
 *   - `manually_closed` → closed
 *   - else UTC clock: day = Elixir `Date.day_of_week - 1` (Monday=0 … Sunday=6),
 *     a row matches when `day_of_week` equals today, `is_closed` is false and
 *     `open_time <= now < close_time` (open inclusive, close exclusive).
 *   - no matching row → closed.
 *
 * Reads from SQLite `reference_data` (`operating-hours` + `business:profile`),
 * so it works fully offline. Known parity limitation (copied from backend, not
 * fixed here): overnight ranges (close <= open) never match.
 */

import { openSyncDatabase } from "../db/connection";
import { getReferenceData } from "../reference/operations";
import type { OperatingHoursEntry } from "../types/api/business.api";

export type BusinessClosedReason =
  | "manually_closed"
  | "outside_hours"
  | "no_hours_configured";

export interface BusinessOpenState {
  open: boolean;
  reason?: BusinessClosedReason;
  /** 0=Monday … 6=Sunday (backend day_of_week convention) */
  dayOfWeek: number;
  /** HH:MM:SS UTC used for the evaluation */
  timeUtc: string;
  evaluatedAt: string;
}

export class BusinessHoursError extends Error {
  code: "BUSINESS_CLOSED" | "HOURS_NOT_SYNCED";
  reason?: BusinessClosedReason;

  constructor(
    code: "BUSINESS_CLOSED" | "HOURS_NOT_SYNCED",
    message: string,
    reason?: BusinessClosedReason,
  ) {
    super(message);
    this.name = "BusinessHoursError";
    this.code = code;
    this.reason = reason;
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toTimeString(v: string | null | undefined): string | null {
  if (!v || typeof v !== "string") return null;
  // Backend Time serializes "HH:MM:SS"; settings screen writes "HH:MM:00".
  return v.slice(0, 8);
}

function normalizeEntries(payload: unknown): OperatingHoursEntry[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload as OperatingHoursEntry[];
  const data = (payload as { data?: unknown }).data;
  if (Array.isArray(data)) return data as OperatingHoursEntry[];
  return [];
}

export async function isBusinessOpenNow(
  businessId: string,
  now: Date = new Date(),
): Promise<BusinessOpenState> {
  const evaluatedAt = new Date().toISOString();
  // Backend: Date.day_of_week (Mon=1..Sun=7) minus 1 → Mon=0..Sun=6 (UTC).
  const dayOfWeek = (now.getUTCDay() + 6) % 7;
  const timeUtc = `${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}:${pad2(now.getUTCSeconds())}`;

  const db = await openSyncDatabase();
  const [hoursRec, profileRec] = await Promise.all([
    getReferenceData<unknown>(db, businessId, "operating-hours"),
    getReferenceData<unknown>(db, businessId, "business:profile"),
  ]);

  const profile = (
    (profileRec?.payload as { data?: Record<string, unknown> } | Record<string, unknown> | null) ??
    null
  );
  const profileData =
    profile && typeof profile === "object" && "data" in (profile as Record<string, unknown>) && (profile as { data?: unknown }).data !== undefined
      ? ((profile as { data?: unknown }).data as Record<string, unknown>)
      : ((profile ?? {}) as Record<string, unknown>);
  if (profileData.manually_closed === true) {
    return { open: false, reason: "manually_closed", dayOfWeek, timeUtc, evaluatedAt };
  }

  const entries = normalizeEntries(hoursRec?.payload);
  if (entries.length === 0) {
    return { open: false, reason: "no_hours_configured", dayOfWeek, timeUtc, evaluatedAt };
  }

  const match = entries.some((e) => {
    if (e.day_of_week !== dayOfWeek || e.is_closed) return false;
    const open = toTimeString(e.open_time);
    const close = toTimeString(e.close_time);
    if (!open || !close) return false;
    return open <= timeUtc && timeUtc < close;
  });

  return match
    ? { open: true, dayOfWeek, timeUtc, evaluatedAt }
    : { open: false, reason: "outside_hours", dayOfWeek, timeUtc, evaluatedAt };
}

/**
 * Guard for order creation — fail-closed. Throws `BusinessHoursError` with
 * code `HOURS_NOT_SYNCED` when no hours are cached (configure in Settings,
 * works offline) or `BUSINESS_CLOSED` when the business is closed.
 * Backend remains the final gate for clock-skew edge cases.
 */
export async function assertBusinessOpenForCreate(
  businessId: string,
  now: Date = new Date(),
): Promise<BusinessOpenState> {
  const state = await isBusinessOpenNow(businessId, now);
  if (state.reason === "no_hours_configured") {
    throw new BusinessHoursError(
      "HOURS_NOT_SYNCED",
      "Operating hours are not available offline — configure them in Settings (works offline) or sync once before taking orders",
      state.reason,
    );
  }
  if (!state.open) {
    throw new BusinessHoursError(
      "BUSINESS_CLOSED",
      state.reason === "manually_closed"
        ? "Business is manually closed — order creation is blocked"
        : "Business is currently closed — order creation is blocked",
      state.reason,
    );
  }
  return state;
}
