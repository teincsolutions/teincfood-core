/**
 * LWW-Register and LWW-Map for reference data (menu/categories/etc.)
 * Per-field last-HLC-wins. HLC strings as version.
 */
import { compareHLCString } from "../utils/hlc";

export type LWW<T> = { value: T; hlc: string; deviceId: string };
export type LWWMap = Record<string, LWW<unknown>>;

export function lwwMerge(existing: LWWMap | null | undefined, incoming: LWWMap): LWWMap {
  const out: LWWMap = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(incoming)) {
    const cur = out[k];
    if (!cur || compareHLCString(v.hlc, cur.hlc) > 0) out[k] = v;
  }
  return out;
}

export function toLWWMap(obj: Record<string, unknown>, hlc: string, deviceId: string): LWWMap {
  const m: LWWMap = {};
  for (const [k, v] of Object.entries(obj)) m[k] = { value: v, hlc, deviceId };
  return m;
}

export function fromLWWMap(m: LWWMap): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) o[k] = v.value;
  return o;
}

// For array items (MenuItem) — merge by id
export function mergeItemArrays(existing: Array<{ id: string } & Record<string, unknown>>, incoming: Array<{ id: string } & Record<string, unknown>>, hlcById: Record<string, string>): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const it of existing) byId.set(it.id, { ...it });
  for (const it of incoming) {
    const cur = byId.get(it.id);
    const hlc = hlcById[it.id] ?? "";
    if (!cur) byId.set(it.id, { ...it });
    else {
      // per-field LWW if both exist: compare hlc for this id
      const curHlc = (cur as unknown as { _hlc?: string })._hlc ?? "";
      if (!curHlc || compareHLCString(hlc, curHlc) >= 0) byId.set(it.id, { ...it, _hlc: hlc });
    }
  }
  return [...byId.values()];
}
