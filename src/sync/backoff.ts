/**
 * Shared retry backoff — one curve everywhere (sync retries, probes stay fixed).
 *
 * delay(attempts) = min(MAX, BASE * 2^attempts) + jitter(±20%).
 * Attempts reset on any success or connectivity regain, so one bad night
 * never permanently slows the device, and a fleet doesn't thunder-herd a
 * recovering backend at the same millisecond.
 */

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
const JITTER_RATIO = 0.2;

export function backoffDelayMs(attempts: number): number {
  const safe = Math.max(0, Math.floor(attempts));
  const capped = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, safe));
  const jitter = capped * JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

/** Deterministic center of the curve (no jitter) — for tests and logging. */
export function backoffCenterMs(attempts: number): number {
  const safe = Math.max(0, Math.floor(attempts));
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, safe));
}

/** Attempt counters keyed by scope (e.g. business id). Reset on success/regain. */
export class BackoffTracker {
  private attempts = new Map<string, number>();

  next(scope: string): number {
    const n = this.attempts.get(scope) ?? 0;
    this.attempts.set(scope, n + 1);
    return backoffDelayMs(n);
  }

  reset(scope: string): void {
    this.attempts.delete(scope);
  }

  resetAll(): void {
    this.attempts.clear();
  }

  count(scope: string): number {
    return this.attempts.get(scope) ?? 0;
  }
}
