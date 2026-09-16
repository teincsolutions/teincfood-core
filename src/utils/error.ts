import type { ApiErrorResponse } from "../types/api";

export function extractFromResponseBody(data: Record<string, unknown>): string | null {
  const errorField = data.error;
  if (errorField && typeof errorField === "object") {
    const msg = (errorField as Record<string, unknown>).message;
    if (typeof msg === "string") return msg;
  }
  if (typeof errorField === "string") {
    if (data.message && typeof data.message === "string") return data.message;
    return errorField;
  }
  const errorsField = data.errors;
  if (errorsField && typeof errorsField === "object") {
    const detail = (errorsField as Record<string, unknown>).detail;
    if (typeof detail === "string") return detail;
  }
  return null;
}

export function extractApiErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object") return "An unexpected error occurred";
  const err = error as Record<string, unknown>;
  const response = err.response as Record<string, unknown> | undefined;
  if (response?.data && typeof response.data === "object") {
    const msg = extractFromResponseBody(response.data as Record<string, unknown>);
    if (msg) return msg;
  }
  if (err.message && typeof err.message === "string") {
    return err.message;
  }
  return "An unexpected error occurred";
}

export function extractApiErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const err = error as Record<string, unknown>;
  // Core ApiError / TransitionError carry code on top level.
  if (typeof err.code === "string") return err.code;
  const response = err.response as Record<string, unknown> | undefined;
  if (response?.data && typeof response.data === "object") {
    const data = response.data as Record<string, unknown>;
    const errorField = data.error;
    if (errorField && typeof errorField === "object") {
      const code = (errorField as Record<string, unknown>).code;
      if (typeof code === "string") return code;
    }
    if (typeof errorField === "string") return errorField;
  }
  if (err.data && typeof err.data === "object") {
    const data = err.data as Record<string, unknown>;
    const errorField = data.error;
    if (errorField && typeof errorField === "object") {
      const code = (errorField as Record<string, unknown>).code;
      if (typeof code === "string") return code;
    }
  }
  return undefined;
}

// Re-export ApiError from http adapter for compatibility
export { ApiError } from "../adapters/http";
