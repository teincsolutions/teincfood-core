/**
 * Shared debug-log ring buffer — single implementation for Business (Expo)
 * and Desktop (Tauri), replacing the per-app copies.
 *
 * Captures (a) console.* output and (b) core syncLogger output into one
 * observable store that Diagnostics screens render with level tabs, search,
 * copy/share and clear. Install once at app bootstrap via
 * initDebugLogCapture(); safe to call repeatedly.
 */

import { syncLogger } from "./sync-logger";

export type LogLevel = "debug" | "info" | "warn" | "error" | "log";

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  args: unknown[];
  text: string;
}

const MAX_ENTRIES = 600;
let entries: LogEntry[] = [];
let seq = 0;
const listeners = new Set<() => void>();
let installed = false;

function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a, null, 2);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function push(level: LogLevel, args: unknown[]) {
  const e: LogEntry = { id: ++seq, ts: new Date().toISOString(), level, args, text: fmt(args) };
  entries.push(e);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {}
  });
}

/** Newest-first snapshot for list rendering. */
export function getDebugLogs(): LogEntry[] {
  return entries.slice().reverse();
}

export function clearDebugLogs() {
  entries = [];
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {}
  });
}

export function subscribeDebugLogs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function pushDebugLog(level: LogLevel, text: string, data?: unknown) {
  push(level, data !== undefined ? [text, data] : [text]);
}

const SYNC_WRAPPED = "__teincDebugLogWrapped";

export function initDebugLogCapture() {
  if (installed) return;
  installed = true;
  // Force core SyncEngine logger on even in production builds — otherwise
  // strategy/timeout/queue decisions stay silent in the field.
  try {
    (syncLogger as unknown as { setEnabled?: (v: boolean) => void }).setEnabled?.(true);
  } catch {}
  // Mirror syncLogger output into the buffer (wrap once).
  try {
    const rec = syncLogger as unknown as Record<string, unknown>;
    if (!rec[SYNC_WRAPPED]) {
      rec[SYNC_WRAPPED] = true;
      (["debug", "info", "warn", "error"] as const).forEach((m) => {
        const orig = (rec[m] as (...a: unknown[]) => void)?.bind(syncLogger);
        if (!orig) return;
        (rec as Record<string, unknown>)[m] = (...a: unknown[]) => {
          try {
            push(m, a);
          } catch {}
          (orig as (...args: unknown[]) => void)(...a);
        };
      });
    }
  } catch {}
  // Mirror console.* output (guarded: React Native has no window).
  try {
    const c = console as unknown as Record<string, (...a: unknown[]) => void>;
    const orig = {
      debug: console.debug.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      log: console.log.bind(console),
    };
    (console.debug as unknown as (...a: unknown[]) => void) = (...a: unknown[]) => {
      push("debug", a);
      orig.debug(...a);
    };
    (console.info as unknown as (...a: unknown[]) => void) = (...a: unknown[]) => {
      push("info", a);
      orig.info(...a);
    };
    (console.warn as unknown as (...a: unknown[]) => void) = (...a: unknown[]) => {
      push("warn", a);
      orig.warn(...a);
    };
    (console.error as unknown as (...a: unknown[]) => void) = (...a: unknown[]) => {
      push("error", a);
      orig.error(...a);
    };
    (console.log as unknown as (...a: unknown[]) => void) = (...a: unknown[]) => {
      push("log", a);
      orig.log(...a);
    };
    void c;
  } catch {}
  try {
    const g = globalThis as unknown as {
      addEventListener?: (t: string, fn: (e: unknown) => void) => void;
    };
    if (typeof g.addEventListener === "function") {
      g.addEventListener("error", (e) => {
        const err = e as { message?: unknown; error?: unknown };
        push("error", [err?.message, err?.error]);
      });
      g.addEventListener("unhandledrejection", (e) => {
        push("error", ["unhandledrejection", (e as { reason?: unknown })?.reason]);
      });
    }
  } catch {}
  try {
    console.debug("[debug-log] capture installed");
  } catch {}
}
