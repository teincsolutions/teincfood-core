/**
 * Attempt counters — monitor-first instrumentation for overload diagnosis.
 *
 * Every retry/poll/reconnect path records one counter tick with its caller
 * tag. Diagnostics screens render per-subsystem totals + per-minute rates so
 * a hot loop (e.g. discovery sweep, WS reconnect, drain storm) is visible
 * without guessing. Pure in-memory; no timers, no network, no behavior.
 */

export type AttemptSubsystem =
  | "ws_connect"
  | "ws_reconnect"
  | "ws_heartbeat"
  | "lan_discover"
  | "lan_dial"
  | "sweep_tick"
  | "ttl_reap"
  | "sync_drain"
  | "rest_attempt"
  | "probe"
  | "refetch";

export interface SubsystemStat {
  subsystem: AttemptSubsystem;
  total: number;
  /** Attempts in the trailing 60s window. */
  perMin: number;
  lastAt: string | null;
  lastDetail: string | null;
}

interface Counter {
  total: number;
  stamps: number[];
  lastAt: string | null;
  lastDetail: string | null;
}

const WINDOW_MS = 60_000;
const counters = new Map<AttemptSubsystem, Counter>();

function counterFor(s: AttemptSubsystem): Counter {
  let c = counters.get(s);
  if (!c) {
    c = { total: 0, stamps: [], lastAt: null, lastDetail: null };
    counters.set(s, c);
  }
  return c;
}

/** Record one attempt. Detail is a short caller/param tag, e.g. "delay=4000" or "GET /orders". */
export function recordAttempt(subsystem: AttemptSubsystem, detail?: string): void {
  try {
    const c = counterFor(subsystem);
    const now = Date.now();
    c.total += 1;
    c.stamps.push(now);
    // Prune outside the trailing window (amortized — stamps only grow via ticks).
    while (c.stamps.length > 0 && now - c.stamps[0] > WINDOW_MS) c.stamps.shift();
    c.lastAt = new Date(now).toISOString();
    if (detail !== undefined) c.lastDetail = detail;
  } catch {}
}

/** Snapshot for Diagnostics screens. Never throws. */
export function getAttemptStats(): SubsystemStat[] {
  try {
    const now = Date.now();
    const out: SubsystemStat[] = [];
    counters.forEach((c, subsystem) => {
      while (c.stamps.length > 0 && now - c.stamps[0] > WINDOW_MS) c.stamps.shift();
      out.push({
        subsystem,
        total: c.total,
        perMin: c.stamps.length,
        lastAt: c.lastAt,
        lastDetail: c.lastDetail,
      });
    });
    out.sort((a, b) => b.perMin - a.perMin || b.total - a.total);
    return out;
  } catch {
    return [];
  }
}

/** Test-only reset. */
export function resetAttemptStats(): void {
  counters.clear();
}
