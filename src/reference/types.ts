/**
 * Types for reference data synchronization.
 *
 * Reference data is data that changes infrequently and is required for
 * day-to-day operation: menus, categories, products, modifiers, taxes,
 * printers, kitchen stations, etc.
 *
 * It is synchronized separately from transactional data through the
 * ReferenceSyncService.
 */

export type ReferenceDataKey =
  | "menu:items"
  | "menu:categories"
  | "roles"
  | "members"
  | "tax-rules"
  | "business:profile"
  | "operating-hours"
  | "subscription:entitlements";

export interface ReferenceDataRecord<T = unknown> {
  key: ReferenceDataKey;
  version: string;
  payload: T;
  downloadedAt: string;
}

export interface ReferenceVersionInfo {
  key: ReferenceDataKey;
  version: string;
  updated_at: string;
}

export interface ReferenceSyncOptions {
  businessId: string;
  keys?: ReferenceDataKey[];
  /** If true, ignore local cache and fetch fresh data. */
  force?: boolean;
  /** If true, only sync keys that are missing or stale. */
  incremental?: boolean;
}

export interface ReferenceSyncResult {
  synced: ReferenceDataKey[];
  skipped: ReferenceDataKey[];
  failed: ReferenceDataKey[];
  errors: Record<ReferenceDataKey, string>;
}

export interface ReferenceChangeSet<T = unknown> {
  key: ReferenceDataKey;
  from_version: string;
  to_version: string;
  changes: T;
}

export interface ReferenceSyncStatus {
  lastSyncAt: string | null;
  isSyncing: boolean;
  error: string | null;
}
