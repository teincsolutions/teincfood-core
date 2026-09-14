/**
 * Core Health Probe — periodic cloud reachability check.
 *
 * Probes `GET /health` using the injected HttpClient with a short timeout.
 * On success: marks cloud reachable (triggers sync replay via connectivity
 * subscribers). On failure: marks unreachable and schedules a retry with
 * exponential backoff (2s → 5min cap, ±20% jitter).
 *
 * Started automatically by `createTeincCore()`. Host apps should not need
 * to call this directly.
 */

import { getConnectivityState, setCloudReachable, subscribeConnectivity } from "../adapters/connectivity";
import { getHttpClient } from "../adapters/http";
import { API_BASE_URL } from "../utils/constants";
import { syncLogger } from "../utils/sync-logger";
import { BackoffTracker } from "./backoff";
import { getActiveBusiness } from "../adapters/business";
import { getAuthToken } from "../adapters/auth";

const PROBE_URL = "/health";
const PROBE_TIMEOUT_MS = 4_000;
const PROBE_INTERVAL_MS = 60_000;
const UNREACHABLE_COOLDOWN_MS = 15_000;
const INITIAL_DELAY_MS = 3_000;

let probeTimer: ReturnType<typeof setInterval> | null = null;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
let stopFn: (() => void) | null = null;
const backoff = new BackoffTracker();

/**
 * Single probe attempt. Returns true if cloud is reachable.
 */
export async function probeCloudHealth(): Promise<boolean> {
  const http = (() => { try { return getHttpClient(); } catch { return null; } })();
  if (!http) return false;

  const { isOnline } = getConnectivityState();
  if (!isOnline) return false;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    await http.get(PROBE_URL, { signal: controller.signal } as unknown);
    clearTimeout(timer);
    backoff.reset("health");
    const was = getConnectivityState().isCloudReachable;
    setCloudReachable("reachable");
    if (was !== "reachable") {
      syncLogger.info("HealthProbe", "Cloud reachable", { previous: was });
      // Kick off pull→merge→push without blocking probe.
      try {
        const bid = getActiveBusiness()?.id;
        if (bid && getAuthToken()) {
          void import("./full-sync").then((m) => m.performFullSync(bid).catch(() => {}));
        }
      } catch {}
    }
    return true;
  } catch {
    // Don't mark unreachable here — the sync engine already handles that
    // when a command times out. This probe only detects recovery.
    // Log and backoff so we re-check later.
    syncLogger.debug("HealthProbe", "Probe failed — will retry", {
      previous: getConnectivityState().isCloudReachable,
    });
    scheduleRetry();
    return false;
  }
}

function scheduleRetry(): void {
  if (cooldownTimer) return;
  const delay = Math.max(UNREACHABLE_COOLDOWN_MS, backoff.next("health"));
  syncLogger.debug("HealthProbe", "Scheduling retry", { delay });
  cooldownTimer = setTimeout(() => {
    cooldownTimer = null;
    void probeCloudHealth();
  }, delay);
}

function startPeriodicProbe(): void {
  if (probeTimer) return;
  probeTimer = setInterval(() => void probeCloudHealth(), PROBE_INTERVAL_MS);
}

function stopPeriodicProbe(): void {
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
  if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
}

/**
 * Start the health probe. Safe to call multiple times (idempotent).
 * Returns a stop function.
 */
export function startHealthProbe(): () => void {
  if (stopFn) return stopFn;

  syncLogger.debug("HealthProbe", "Starting", { probeUrl: `${API_BASE_URL}${PROBE_URL}` });

  // Initial probe (deferred so host bridges can set up first)
  cooldownTimer = setTimeout(() => {
    cooldownTimer = null;
    void probeCloudHealth();
  }, INITIAL_DELAY_MS);

  // Periodic probe
  startPeriodicProbe();

  // Re-probe when network regains
  let prevOnline = getConnectivityState().isOnline;
  const unsub = subscribeConnectivity(() => {
    const { isOnline } = getConnectivityState();
    if (isOnline && !prevOnline) {
      syncLogger.debug("HealthProbe", "Network regained — probing");
      void probeCloudHealth();
    }
    prevOnline = isOnline;
  });

  stopFn = () => {
    stopPeriodicProbe();
    unsub();
    stopFn = null;
  };
  return stopFn;
}

/**
 * Stop the health probe and clean up all timers.
 */
export function stopHealthProbe(): void {
  if (stopFn) stopFn();
}
