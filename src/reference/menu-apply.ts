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

async function patchKey(
  businessId: string,
  key: ReferenceDataKey,
  patch: (arr: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
): Promise<boolean> {
  try {
    const db = await openSyncDatabase();
    const rec = await getReferenceData<unknown>(db, businessId, key);
    if (!rec) return false;
    const next = patch(asArray(rec.payload));
    await setReferenceData(db, businessId, {
      key,
      version: rec.version,
      payload: withArray(rec.payload, next),
      downloadedAt: new Date().toISOString(),
      lastEventId: rec.lastEventId ?? null,
      lastHlc: rec.lastHlc ?? null,
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
  command: Pick<Command, "command_type" | "entity_id" | "command_id" | "payload">,
): Promise<{ keys: ReferenceDataKey[]; applied: boolean }> {
  const payload = (command.payload ?? {}) as Record<string, unknown>;
  const idOf = (v: unknown) => (typeof v === "string" && v ? v : null);
  switch (command.command_type) {
    case "menu:create_item": {
      const id = idOf(command.entity_id) ?? idOf(payload.id) ?? generateUUID();
      const item = { ...(payload as Record<string, unknown>), id };
      delete (item as Record<string, unknown>).command_id;
      const applied = await patchKey(businessId, MENU_ITEM_KEY, (arr) =>
        arr.some((o) => String(o.id) === id) ? arr.map((o) => (String(o.id) === id ? { ...o, ...item } : o)) : [...arr, item],
      );
      return { keys: [MENU_ITEM_KEY], applied };
    }
    case "menu:update_item": {
      const id = idOf(command.entity_id) ?? idOf(payload.id) ?? idOf(payload.item_id);
      if (!id) return { keys: [MENU_ITEM_KEY], applied: false };
      const patch = { ...(payload as Record<string, unknown>) };
      delete patch.command_id;
      const applied = await patchKey(businessId, MENU_ITEM_KEY, (arr) =>
        arr.map((o) => (String(o.id) === id ? { ...o, ...patch, id } : o)),
      );
      return { keys: [MENU_ITEM_KEY], applied };
    }
    case "menu:delete_item": {
      const id = idOf(command.entity_id) ?? idOf(payload.id);
      if (!id) return { keys: [MENU_ITEM_KEY], applied: false };
      const applied = await patchKey(businessId, MENU_ITEM_KEY, (arr) => arr.filter((o) => String(o.id) !== id));
      return { keys: [MENU_ITEM_KEY], applied };
    }
    case "menu:create_category": {
      const id = idOf(command.entity_id) ?? idOf(payload.id) ?? generateUUID();
      const cat = { ...(payload as Record<string, unknown>), id };
      delete (cat as Record<string, unknown>).command_id;
      const applied = await patchKey(businessId, MENU_CATEGORY_KEY, (arr) =>
        arr.some((o) => String(o.id) === id) ? arr.map((o) => (String(o.id) === id ? { ...o, ...cat } : o)) : [...arr, cat],
      );
      return { keys: [MENU_CATEGORY_KEY], applied };
    }
    case "menu:update_category": {
      const id = idOf(command.entity_id) ?? idOf(payload.id) ?? idOf(payload.category_id);
      if (!id) return { keys: [MENU_CATEGORY_KEY], applied: false };
      const patch = { ...(payload as Record<string, unknown>) };
      delete patch.command_id;
      const applied = await patchKey(businessId, MENU_CATEGORY_KEY, (arr) =>
        arr.map((o) => (String(o.id) === id ? { ...o, ...patch, id } : o)),
      );
      return { keys: [MENU_CATEGORY_KEY], applied };
    }
    case "menu:delete_category": {
      const id = idOf(command.entity_id) ?? idOf(payload.id) ?? idOf(payload.category_id);
      if (!id) return { keys: [MENU_CATEGORY_KEY], applied: false };
      const applied = await patchKey(businessId, MENU_CATEGORY_KEY, (arr) => arr.filter((o) => String(o.id) !== id));
      return { keys: [MENU_CATEGORY_KEY], applied };
    }
    default:
      return { keys: [], applied: false };
  }
}

/** Keys whose cache a menu command affects (for fan-out without applying). */
export function menuCommandKeys(commandType: string): ReferenceDataKey[] {
  if (commandType.startsWith("menu:") && commandType.includes("categor")) return [MENU_CATEGORY_KEY];
  if (commandType.startsWith("menu:")) return [MENU_ITEM_KEY];
  return [];
}
