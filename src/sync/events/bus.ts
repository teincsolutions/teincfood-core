/**
 * Event bus — domain events (§14). Canonical in src/sync/types DomainEvent + SyncEngine.publish.
 */
export type { DomainEvent } from "../types";
export { syncEngine, SyncEngine } from "../engine";
