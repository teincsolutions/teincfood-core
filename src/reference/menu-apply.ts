/**
 * Local application of menu commands to the durable reference cache.
 *
 * Used by (a) handleNodeCommand when this device executes a peer's menu
 * command over LAN, and (b) the engine queue branch for optimistic local
 * apply while fully offline. Shapes mirror the cloud fetchers
 * (reference/service fetchFallback): menu:items payload {data:[...]}, 
 * menu:categories payload {data:[...]} (or bare array — tolerated).
 *
 * Versions are intentionally left untouched: optimistic/LAN applies converge
 * peers via explicit reference_data.changed events + reference_fetch (which
 * serve payloads directly, no version compare). Real versions come from the
 * backend when the command replays through the cloud path.
 */
import { openSyncDatabase } from "../db/connection";
import { getReferenceData, setReferenceData } from "./operations";
import type { ReferenceDataKey, ReferenceDataRecord } from "./types";
import { syncLogger } from "../utils/sync-logger";
import { generateUUID } from "../utils/uuid";
import type { Command } from "../sync/types";
import { hlcToString, tickHLC, hlcFromString } from "../utils/hlc";
import { getAppInstanceId } from "../adapters/devices";
import { clearRecordTombstone, markRecordDeleted } from "./tombstones";

export const MENU_ITEM_KEY: ReferenceDataKey = "menu:items";
export const MENU_CATEGORY_KEY: ReferenceDataKey = "menu:categories";

function asArray(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  const data = (payload as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

function withArray(payload: unknown, arr: Array<Record<string, unknown>>): unknown {
  if (Array.isArray(payload)) return arr;
  if (payload && typeof payload === "object") return { ...(payload as Record<string, unknown>), data: arr };
  return { data: arr };
}

/**
 * Extract the caller-built cache record from a menu command payload. The
 * reference cache holds backend-shaped records ONLY (MenuItem / MenuCategory
 * exactly as the serializer returns them) — never wire payloads. Callers
 * build the record alongside the wire payload; core performs no translation.
 * A command without a record writes nothing (cloud convergence fills the
 * cache on the next pull).
 */
function cacheRecord(payload: Record<string, unknown>): Record<string, unknown> | null {
  const rec = payload.cacheRecord;
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  return rec as Record<string, unknown>;
}

async function patchKey(
  businessId: string,
  key: ReferenceDataKey,
  patch: (arr: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
): Promise<boolean> {
  try {
    const db = await openSyncDatabase();
    const rec = await getReferenceData<unknown>(db, businessId, key);
    // Seed empty row if first-ever offline create before any pull.
    if (!rec) {
      const next = patch([]);
      const hlc = hlcToString(tickHLC(Date.now(), null, getAppInstanceId()));
      await setReferenceData(db, businessId, {
        key,
        version: hlc,
        payload: withArray({ data: [] }, next),
        downloadedAt: new Date().toISOString(),
        lastEventId: `evt_${hlc}`,
        lastHlc: hlc,
      } as ReferenceDataRecord<unknown>);
      return true;
    }
    const next = patch(asArray(rec.payload));
    const hlc = hlcToString(tickHLC(Date.now(), hlcFromString(rec.lastHlc ?? rec.version) ?? null, getAppInstanceId()));
    await setReferenceData(db, businessId, {
      key,
      version: hlc,
      payload: withArray(rec.payload, next),
      downloadedAt: new Date().toISOString(),
      lastEventId: `evt_${hlc}`,
      lastHlc: hlc,
    } as ReferenceDataRecord<unknown>);
    return true;
  } catch (e) {
    syncLogger.debug("MenuApply", "local menu patch failed", { businessId, key, err: String(e) });
    return false;
  }
}

/**
 * Apply a menu:* command to the local reference cache. Returns affected keys
 * (for reference_data.changed fan-out) and whether anything was written.
 * Idempotent by entity id: re-applying the same command converges.
 */
export async function applyMenuCommandLocal(
  businessId: string,
  command: Pick<
    Command,
    "command_type" | "entity_id" | "command_id" | "payload" | "timestamp"
  >,
): Promise<{ keys: ReferenceDataKey[]; applied: boolean }> {
  const payload = (command.payload ?? {}) as Record<string, unknown>;
  const idOf = (v: unknown) => (typeof v === "string" && v ? v : null);
  const stamp = command.timestamp ?? new Date().toISOString();
  switch (command.command_type) {
    case "menu:create_item": {
      const id = idOf(command.entity_id) ?? idOf(payload.id) ?? generateUUID();
      const record = cacheRecord(payload);
      if (!record) {
        syncLogger.debug("MenuApply", "create_item without cacheRecord — skipping cache write", { businessId, id: command.entity_id });
        return { keys: [MENU_ITEM_KEY], applied: false };
      }
      const item = { ...record, id };
      const applied = await patchKey(businessId, MENU_ITEM_KEY, (arr) => {
        stashPrior(arr, businessId, id);
        return arr.some((o) => String(o.id) === id) ? arr.map((o) => (String(o.id) === id ? item : o)) : [...arr, item];
      });
      await clearRecordTombstone(await openSyncDatabase(), businessId, MENU_ITEM_KEY, id);
      return { keys: [MENU_ITEM_KEY], applied };
    }
    case "menu:update_item": {
      const id = idOf(command.entity_id) ?? idOf(payload.id) ?? idOf(payload.item_id);
      if (!id) return { keys: [MENU_ITEM_KEY], applied: false };
      const record = cacheRecord(payload);
      if (!record) {
        syncLogger.debug("MenuApply", "update_item without cacheRecord — skipping cache write", { businessId, id });
        return { keys: [MENU_ITEM_KEY], applied: false };
      }
      const applied = await patchKey(businessId, MENU_ITEM_KEY, (arr) => {
        stashPrior(arr, businessId, id);
        return arr.map((o) => (String(o.id) === id ? { ...record, id } : o));
      });
      await clearRecordTombstone(await openSyncDatabase(), businessId, MENU_ITEM_KEY, id);
      return { keys: [MENU_ITEM_KEY], applied };
    }
    case "menu:delete_item": {
      const id = idOf(command.entity_id) ?? idOf(payload.id);
      if (!id) return { keys: [MENU_ITEM_KEY], applied: false };
      const applied = await patchKey(businessId, MENU_ITEM_KEY, (arr) => arr.filter((o) => String(o.id) !== id));
      await markRecordDeleted(await openSyncDatabase(), businessId, MENU_ITEM_KEY, id, stamp);
      return { keys: [MENU_ITEM_KEY], applied };
    }
    case "menu:create_category": {
      const id = idOf(command.entity_id) ?? idOf(payload.id) ?? generateUUID();
      const record = cacheRecord(payload);
      if (!record) {
        syncLogger.debug("MenuApply", "create_category without cacheRecord — skipping cache write", { businessId });
        return { keys: [MENU_CATEGORY_KEY], applied: false };
      }
      const cat = { ...record, id };
      const applied = await patchKey(businessId, MENU_CATEGORY_KEY, (arr) => {
        stashPrior(arr, businessId, id);
        return arr.some((o) => String(o.id) === id) ? arr.map((o) => (String(o.id) === id ? cat : o)) : [...arr, cat];
      });
      await clearRecordTombstone(await openSyncDatabase(), businessId, MENU_CATEGORY_KEY, id);
      return { keys: [MENU_CATEGORY_KEY], applied };
    }
    case "menu:update_category": {
      const id = idOf(command.entity_id) ?? idOf(payload.id) ?? idOf(payload.category_id);
      if (!id) return { keys: [MENU_CATEGORY_KEY], applied: false };
      const record = cacheRecord(payload);
      if (!record) {
        syncLogger.debug("MenuApply", "update_category without cacheRecord — skipping cache write", { businessId, id });
        return { keys: [MENU_CATEGORY_KEY], applied: false };
      }
      const applied = await patchKey(businessId, MENU_CATEGORY_KEY, (arr) => {
        stashPrior(arr, businessId, id);
        return arr.map((o) => (String(o.id) === id ? { ...record, id } : o));
      });
      await clearRecordTombstone(await openSyncDatabase(), businessId, MENU_CATEGORY_KEY, id);
      return { keys: [MENU_CATEGORY_KEY], applied };
    }
    case "menu:delete_category": {
      const id = idOf(command.entity_id) ?? idOf(payload.id) ?? idOf(payload.category_id);
      if (!id) return { keys: [MENU_CATEGORY_KEY], applied: false };
      const applied = await patchKey(businessId, MENU_CATEGORY_KEY, (arr) => arr.filter((o) => String(o.id) !== id));
      await markRecordDeleted(await openSyncDatabase(), businessId, MENU_CATEGORY_KEY, id, stamp);
      return { keys: [MENU_CATEGORY_KEY], applied };
    }
    default:
      return { keys: [], applied: false };
  }
}

/**
 * Prior-record stash for toast-and-revert: before overwriting a cached row,
 * the previous record is kept in memory so a backend rejection can restore
 * it. Creates stash a tombstone (revert deletes the row).
 */
const priorRecords = new Map<string, Record<string, unknown> | null>();

function stashPrior(arr: Array<Record<string, unknown>>, businessId: string, id: string): void {
  try {
    const prev = arr.find((o) => String(o.id) === id);
    priorRecords.set(`${businessId}:${id}`, prev ? { ...prev } : null);
  } catch {}
}

/**
 * Revert an optimistic menu write after a definitive backend rejection:
 * restores the stashed prior record, or deletes the row for creates.
 * Peers converge via reference_fetch/pull on the next sync.
 */
export async function revertMenuCommand(businessId: string, commandType: string, entityId: string): Promise<boolean> {
  const key = `${businessId}:${entityId}`;
  try {
    if (commandType === "menu:create_item") {
      const applied = await patchKey(businessId, MENU_ITEM_KEY, (arr) => arr.filter((o) => String(o.id) !== entityId));
      priorRecords.delete(key);
      return applied;
    }
    if (commandType === "menu:update_item") {
      const prior = priorRecords.get(key);
      priorRecords.delete(key);
      if (prior === undefined) return false;
      const applied = await patchKey(businessId, MENU_ITEM_KEY, (arr) => {
        if (prior === null) return arr.filter((o) => String(o.id) !== entityId);
        return arr.some((o) => String(o.id) === entityId)
          ? arr.map((o) => (String(o.id) === entityId ? { ...prior, id: entityId } : o))
          : [...arr, { ...prior, id: entityId }];
      });
      return applied;
    }
    if (commandType === "menu:create_category") {
      const applied = await patchKey(businessId, MENU_CATEGORY_KEY, (arr) => arr.filter((o) => String(o.id) !== entityId));
      priorRecords.delete(key);
      return applied;
    }
    if (commandType === "menu:update_category") {
      const prior = priorRecords.get(key);
      priorRecords.delete(key);
      if (prior === undefined) return false;
      const applied = await patchKey(businessId, MENU_CATEGORY_KEY, (arr) => {
        if (prior === null) return arr.filter((o) => String(o.id) !== entityId);
        return arr.some((o) => String(o.id) === entityId)
          ? arr.map((o) => (String(o.id) === entityId ? { ...prior, id: entityId } : o))
          : [...arr, { ...prior, id: entityId }];
      });
      return applied;
    }
  } catch {}
  return false;
}

/** Keys whose cache a menu command affects (for fan-out without applying). */
export function menuCommandKeys(commandType: string): ReferenceDataKey[] {
  if (commandType.startsWith("menu:") && commandType.includes("categor")) return [MENU_CATEGORY_KEY];
  if (commandType.startsWith("menu:")) return [MENU_ITEM_KEY];
  return [];
}

function isCanonicalMenuItem(o: unknown): boolean {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  const bp = r.basePrice as Record<string, unknown> | undefined;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    !!bp &&
    typeof bp.amountMinor === "number" &&
    typeof bp.currencyCode === "string" &&
    Array.isArray(r.variants) &&
    Array.isArray(r.extras) &&
    Array.isArray(r.dietary_tags)
  );
}

/**
 * One-time janitor: remove cached menu rows that are not backend-shaped
 * MenuItems (written by older builds that cached raw wire payloads). This is
 * explicit removal of invalid data — never translation. The outbox remains
 * the source of truth: queued creates replay to the backend and the next
 * pull restores canonical rows. Returns the purge count for logging.
 */
export async function purgeNonCanonicalMenuCache(businessId: string): Promise<number> {
  try {
    const db = await openSyncDatabase();
    const rec = await getReferenceData<unknown>(db, businessId, MENU_ITEM_KEY);
    if (!rec) return 0;
    const arr = asArray(rec.payload);
    const kept = arr.filter(isCanonicalMenuItem);
    const purged = arr.length - kept.length;
    if (purged === 0) return 0;
    const hlc = hlcToString(tickHLC(Date.now(), hlcFromString(rec.lastHlc ?? rec.version) ?? null, getAppInstanceId()));
    await setReferenceData(db, businessId, {
      key: MENU_ITEM_KEY,
      version: hlc,
      payload: withArray(rec.payload, kept),
      downloadedAt: new Date().toISOString(),
      lastEventId: `evt_${hlc}`,
      lastHlc: hlc,
    } as ReferenceDataRecord<unknown>);
    syncLogger.warn("MenuApply", "purged non-canonical cached menu rows", { businessId, purged, kept: kept.length });
    return purged;
  } catch (e) {
    syncLogger.debug("MenuApply", "menu cache purge failed", { businessId, err: String(e) });
    return 0;
  }
}
