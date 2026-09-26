/**
 * Sync-failure reporter adapter.
 *
 * Core never depends on the observability SDK. The host app registers a
 * reporter at boot (built on `@teincfood/observability`) and core forwards
 * every failed command attempt so operators can see which device/app/user is
 * struggling and go fix it.
 */

export type SyncFailurePhase = "outbox" | "sync_jobs";

export interface SyncFailureReport {
  /** Which queue produced the failure. */
  phase: SyncFailurePhase;
  business_id: string;
  user_id?: string;
  /** Stable per-install device id (matches the telemetry device). */
  device_id?: string;
  command_type: string;
  command_id?: string;
  entity_id?: string;
  /** HTTP status when the failure came from a response. */
  status?: number;
  /** Backend/guard error code. */
  code?: string;
  message?: string;
  attempts?: number;
  /** True when the command was dead-lettered (no further auto-retry). */
  terminal: boolean;
  transport?: string;
}

export type SyncFailureReporter = (report: SyncFailureReport) => void;

let reporter: SyncFailureReporter | null = null;

export function setSyncFailureReporter(next: SyncFailureReporter | null): void {
  reporter = next;
}

/** Fire-and-forget; never throws, safe before a reporter is registered. */
export function reportSyncFailure(report: SyncFailureReport): void {
  if (!reporter) return;
  try {
    reporter(report);
  } catch {
    /* telemetry must never break sync */
  }
}
