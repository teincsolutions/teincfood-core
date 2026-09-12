/**
 * Deprecated realtime stubs — the single global core useSyncReconciliation +
 * useEventsConnection handles all realtime. Kept as no-ops for any lingering
 * call sites during migration.
 */

/** @deprecated Global core merge handles it. */
export function useRealtimeInvalidation(): void {}

/** @deprecated Global core merge handles it. */
export function useOrderRealtimeUpdates(_rootKey?: readonly unknown[]): void {}
