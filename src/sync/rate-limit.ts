/**
 * Global rate-limit gate + pacer for outgoing SYNC requests.
 *
 * Goal: drain the offline queue "naturally" — paced at roughly the rate of
 * real user activity (~3 req/sec) so the backend never sees a burst that looks
 * like an attack. When the server does throttle us (429), every sync path
 * pauses until the Retry-After window elapses instead of hammering.
 *
 * User-initiated taps are NOT paced here; human pace is already the natural
 * rate. Only background drains/replays/pulls/reference go through paceSync().
 */

const DEFAULT_RETRY_AFTER_MS = 60_000;
/** ~3 requests/second ceiling for background sync. */
export const SYNC_MIN_INTERVAL_MS = 333;

let rateLimitedUntil = 0;
let reportedWindowUntil = 0;
let rateLimitHitsInWindow = 0;

/** Record a 429: pause all sync until retryAfterMs (default 60s). */
export function noteRateLimited(retryAfterMs?: number): void {
  const delay =
    retryAfterMs && retryAfterMs > 0 ? retryAfterMs : DEFAULT_RETRY_AFTER_MS;
  const until = Date.now() + delay;
  if (until > rateLimitedUntil) rateLimitedUntil = until;
  if (until > reportedWindowUntil) {
    reportedWindowUntil = until;
    rateLimitHitsInWindow = 0;
  }
  rateLimitHitsInWindow += 1;
}

/** Milliseconds remaining in the current cooldown (0 when not throttled). */
export function getRateLimitWaitMs(): number {
  return Math.max(0, rateLimitedUntil - Date.now());
}

export function isRateLimited(): boolean {
  return getRateLimitWaitMs() > 0;
}

/**
 * Whether this throttle window has already been reported. The first 429 of a
 * window reports (terminal:false); repeats stay silent so a storm does not
 * spam observability.
 */
export function shouldReportRateLimit(): boolean {
  return rateLimitHitsInWindow <= 1;
}

export function getRateLimitHitCount(): number {
  return rateLimitHitsInWindow;
}

/** Test/reset hook. */
export function resetRateLimitForTests(): void {
  rateLimitedUntil = 0;
  reportedWindowUntil = 0;
  rateLimitHitsInWindow = 0;
  lastSyncRequestAt = 0;
  pacerChain = Promise.resolve();
}

/**
 * Extract Retry-After from an error: backend body
 * `{ error: { retry_after_seconds } }` or a `retry-after` header.
 */
export function extractRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as {
    response?: { headers?: Record<string, unknown>; data?: unknown };
    retry_after_seconds?: unknown;
  };
  const body = (e.response?.data ?? e) as {
    error?: { retry_after_seconds?: unknown };
    retry_after_seconds?: unknown;
  };
  const secs =
    body?.error?.retry_after_seconds ?? body?.retry_after_seconds ?? undefined;
  if (typeof secs === "number" && secs > 0) return secs * 1000;
  const header = e.response?.headers?.["retry-after"];
  const headerSecs = typeof header === "string" ? Number(header) : NaN;
  if (Number.isFinite(headerSecs) && headerSecs > 0) return headerSecs * 1000;
  return undefined;
}

// ── Pacer ────────────────────────────────────────────────────────────────────

let lastSyncRequestAt = 0;
let pacerChain: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Await a paced slot for the next background sync request. Serialized via a
 * promise chain so concurrent callers still space out at SYNC_MIN_INTERVAL_MS.
 */
export function paceSync(): Promise<void> {
  const run = pacerChain.then(async () => {
    const wait = Math.max(
      0,
      lastSyncRequestAt + SYNC_MIN_INTERVAL_MS - Date.now(),
    );
    if (wait > 0) await sleep(wait);
    lastSyncRequestAt = Date.now();
  });
  pacerChain = run.catch(() => undefined);
  return run;
}

/**
 * Wait out an active cooldown. Returns false if we should abort this sync
 * attempt instead of waiting (callers schedule their own retry).
 */
export async function waitForRateLimitClear(): Promise<boolean> {
  const wait = getRateLimitWaitMs();
  if (wait <= 0) return true;
  await sleep(wait);
  return getRateLimitWaitMs() <= 0;
}
