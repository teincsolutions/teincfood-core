/**
 * Hybrid Logical Clock (HLC) for offline-first causal ordering.
 *
 * Encodes as "wallMs-counter-deviceId" (e.g. "1714560000000-2-01").
 * Ordering: wallMs → counter → deviceId lexical.
 * Guarantees monotonic per-device even if wall clock skews.
 */

export interface HLC {
  wallMs: number;
  counter: number;
  deviceId: string;
}

export function hlcToString(h: HLC): string {
  return `${h.wallMs}-${String(h.counter).padStart(6, "0")}-${h.deviceId}`;
}

export function hlcFromString(s: string): HLC | null {
  const parts = s.split("-");
  if (parts.length < 3) return null;
  const wallMs = Number(parts[0]);
  const counter = Number(parts[1]);
  const deviceId = parts.slice(2).join("-");
  if (!Number.isFinite(wallMs) || !Number.isFinite(counter) || !deviceId) return null;
  return { wallMs, counter, deviceId };
}

export function compareHLC(a: HLC, b: HLC): number {
  if (a.wallMs !== b.wallMs) return a.wallMs - b.wallMs;
  if (a.counter !== b.counter) return a.counter - b.counter;
  if (a.deviceId < b.deviceId) return -1;
  if (a.deviceId > b.deviceId) return 1;
  return 0;
}

export function compareHLCString(a: string, b: string): number {
  const ha = hlcFromString(a);
  const hb = hlcFromString(b);
  if (!ha && !hb) return a.localeCompare(b);
  if (!ha) return -1;
  if (!hb) return 1;
  return compareHLC(ha, hb);
}

export function tickHLC(wallMs: number, last: HLC | null, deviceId: string): HLC {
  if (!last) return { wallMs, counter: 0, deviceId };
  if (wallMs > last.wallMs) return { wallMs, counter: 0, deviceId };
  if (wallMs === last.wallMs) return { wallMs, counter: last.counter + 1, deviceId };
  // wallMs < last.wallMs (clock skew) — bump counter
  return { wallMs: last.wallMs, counter: last.counter + 1, deviceId };
}

export function maxHLC(a: HLC | null, b: HLC | null): HLC | null {
  if (!a) return b;
  if (!b) return a;
  return compareHLC(a, b) >= 0 ? a : b;
}
