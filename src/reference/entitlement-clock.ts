/**
 * Monotonic entitlement clock — own counter, never device wall-clock.
 *
 * Clients anchor to backend `server_time` on every entitlements sync and
 * advance with a monotonic source (`performance.now()`). Wall-clock
 * backdating cannot extend a trial: time only moves forward from the last
 * anchored/seen server instant, and survives restarts via KV persistence.
 */

import { kvGetItem, kvSetItem } from "../adapters/kv";

const ANCHOR_KEY = "sub:clock-anchor";
const LAST_SEEN_KEY = "sub:clock-last-seen";

export interface EntitlementClockAnchor {
  /** Trusted server instant (ms since epoch) from the last envelope. */
  serverMs: number;
  /** Monotonic reading at the moment of anchoring. */
  monoBase: number;
}

type MonoSource = () => number;

let monoSource: MonoSource | null = null;

/** Test seam: inject a deterministic monotonic source. */
export function setMonoSource(fn: MonoSource | null): void {
  monoSource = fn;
}

export function monoNow(): number {
  try {
    if (monoSource) return monoSource();
    const g = globalThis as unknown as {
      performance?: { now?: () => number };
    };
    if (typeof g.performance?.now === "function") return g.performance.now();
  } catch {
    /* fall through */
  }
  return Date.now();
}

async function readAnchor(): Promise<EntitlementClockAnchor | null> {
  try {
    const raw = await kvGetItem(ANCHOR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EntitlementClockAnchor;
    if (!Number.isFinite(parsed.serverMs) || !Number.isFinite(parsed.monoBase)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readLastSeen(): Promise<number | null> {
  try {
    const raw = await kvGetItem(LAST_SEEN_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Anchor the clock to a trusted backend server_time.
 * Always moves forward: a stale or replayed server_time (older than the
 * current anchor) never rewinds the clock AND never resets the monotonic
 * base — otherwise re-reading a cached envelope would erase elapsed
 * offline time and grant perpetual access.
 */
export async function anchorServerTime(serverTimeIso: string): Promise<number> {
  const serverMs = Date.parse(serverTimeIso);
  const now = monoNow();
  if (!Number.isFinite(serverMs)) return getServerNowMs();

  const prev = await readAnchor();
  const lastSeen = await readLastSeen();

  if (prev && serverMs <= prev.serverMs) return getServerNowMs();

  const base = Math.max(serverMs, prev?.serverMs ?? -Infinity, lastSeen ?? -Infinity);
  const anchor: EntitlementClockAnchor = { serverMs: base, monoBase: now };
  try {
    await kvSetItem(ANCHOR_KEY, JSON.stringify(anchor));
    await kvSetItem(LAST_SEEN_KEY, String(base));
  } catch {
    /* persistence is best-effort; in-memory math still holds for the session */
  }
  return base;
}

/**
 * Current server-anchored instant (ms). Monotonic non-decreasing within
 * what persistence allows. Falls back to wall-clock only when never anchored
 * (first launch before any sync) — callers treat unanchored as unverified.
 */
export async function getServerNowMs(): Promise<number> {
  const anchor = await readAnchor();
  const lastSeen = await readLastSeen();
  if (!anchor) return lastSeen ?? Date.now();

  let elapsed = monoNow() - anchor.monoBase;
  // After a process restart performance.now() resets: elapsed goes negative.
  // Clamp to zero so time never runs backwards; lastSeen still bounds it.
  if (!Number.isFinite(elapsed) || elapsed < 0) elapsed = 0;

  const candidate = anchor.serverMs + elapsed;
  const now = Math.max(candidate, lastSeen ?? -Infinity, anchor.serverMs);
  return now;
}

/** True once at least one trusted server_time has been anchored. */
export async function isAnchored(): Promise<boolean> {
  return (await readAnchor()) != null;
}

/** Last trusted anchor instant (ms), or null when never synced. */
export async function getLastAnchorMs(): Promise<number | null> {
  const anchor = await readAnchor();
  return anchor?.serverMs ?? null;
}

/** Test seam: clear persisted clock state. */
export async function resetEntitlementClock(): Promise<void> {
  const { kvRemoveItem } = await import("../adapters/kv");
  await kvRemoveItem(ANCHOR_KEY);
  await kvRemoveItem(LAST_SEEN_KEY);
}
