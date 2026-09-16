/**
 * Coded errors for order/delivery transitions and sync control flow.
 *
 * Never branch on error message text: every backend action error carries a
 * machine-readable `code` ({error: {code, message}}), and local guard
 * rejections use the same codes below. Callers switch on `error.code`.
 *
 * Codes mirror the backend where semantics match (INVALID_TRANSITION,
 * FORBIDDEN, ORDER_NOT_FOUND); client-only conditions use their own codes
 * (ONLINE_REQUIRED, NO_ACTIVE_BUSINESS, SUBSCRIPTION_REQUIRED,
 * REPLAY_DEFERRED, MISSING_RIDER, NO_DELIVERY).
 */

export const TRANSITION_ERROR_CODES = {
  INVALID_TRANSITION: "INVALID_TRANSITION",
  ONLINE_REQUIRED: "ONLINE_REQUIRED",
  NO_ACTIVE_BUSINESS: "NO_ACTIVE_BUSINESS",
  ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  SUBSCRIPTION_REQUIRED: "SUBSCRIPTION_REQUIRED",
  REPLAY_DEFERRED: "REPLAY_DEFERRED",
  MISSING_RIDER: "MISSING_RIDER",
  NO_DELIVERY: "NO_DELIVERY",
} as const;

export type TransitionErrorCode =
  (typeof TRANSITION_ERROR_CODES)[keyof typeof TRANSITION_ERROR_CODES];

export class TransitionError extends Error {
  code: TransitionErrorCode | string;

  constructor(code: TransitionErrorCode | string, message: string) {
    super(message);
    this.name = "TransitionError";
    this.code = code;
  }
}

import { extractApiErrorCode } from "../utils/error";

/** Read a machine-readable error code off any thrown value. */
export function errorCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  // Backend-shaped errors nested under response/data ({error: {code}}).
  return extractApiErrorCode(error);
}

/**
 * Guard rejections that must stand: the transport must surface them instead
 * of POSTing past them (the complete-pickup 422 storm on delivery orders).
 * ORDER_NOT_FOUND is intentionally excluded — the device may simply never
 * have seen the order, in which case direct-REST fallback is correct.
 */
const FINAL_GUARD_CODES: ReadonlySet<string> = new Set([
  TRANSITION_ERROR_CODES.INVALID_TRANSITION,
  TRANSITION_ERROR_CODES.ONLINE_REQUIRED,
  TRANSITION_ERROR_CODES.NO_ACTIVE_BUSINESS,
  TRANSITION_ERROR_CODES.FORBIDDEN,
  TRANSITION_ERROR_CODES.SUBSCRIPTION_REQUIRED,
]);

export function isFinalGuardRejection(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code !== undefined && FINAL_GUARD_CODES.has(code);
}

export function isReplayDeferred(error: unknown): boolean {
  return errorCodeOf(error) === TRANSITION_ERROR_CODES.REPLAY_DEFERRED;
}
