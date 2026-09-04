/**
 * Event journal — durable, dedup ON CONFLICT(event_id) DO NOTHING (§15).
 * Canonical in src/db/operations (insertEvent, getUnsyncedEvents, markEventsSynced).
 */
export { insertEvent, getUnsyncedEvents, markEventsSynced, getEventsForEntity } from "../../db/operations";
export type { InsertEventInput } from "../../db/operations";
