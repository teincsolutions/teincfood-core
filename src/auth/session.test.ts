import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractAuthFailure,
  isAccessExpired,
  isSessionDead,
  hasAuthRetrySkip,
  refreshSession,
  withAuthRetry,
  SKIP_AUTH_RETRY,
  SESSION_DEAD_CODES,
} from "./session";
import { ApiError } from "../adapters/http";
import { setHttpClient } from "../adapters/http";
import {
  setAuthRefreshProvider,
  setAuthTokensProvider,
  setAuthClearProvider,
} from "../adapters/auth";

function axiosLike(status: number, code?: string, message?: string) {
  const err = new Error(message ?? "Request failed") as Error & {
    response?: { status?: number; data?: unknown };
  };
  err.response = {
    status,
    data: code ? { error: { code, message } } : undefined,
  };
  return err;
}

describe("extractAuthFailure", () => {
  it("reads raw axios shape", () => {
    expect(extractAuthFailure(axiosLike(401, "TOKEN_EXPIRED"))).toEqual({
      status: 401,
      code: "TOKEN_EXPIRED",
      message: "Request failed",
    });
  });
  it("reads core ApiError shape", () => {
    expect(
      extractAuthFailure(new ApiError("Token has expired", 401, "REFRESH_FAILED")),
    ).toEqual({ status: 401, code: "REFRESH_FAILED", message: "Token has expired" });
  });
  it("reads host ApiError wrapper shape ({status, data})", () => {
    const err = Object.assign(new Error("Token has expired"), {
      status: 401,
      data: { error: { code: "REFRESH_FAILED" } },
    });
    expect(extractAuthFailure(err)).toEqual({
      status: 401,
      code: "REFRESH_FAILED",
      message: "Token has expired",
    });
  });
  it("drops transport codes, keeps backend codes", () => {
    expect(
      extractAuthFailure(Object.assign(new Error("x"), { code: "ERR_NETWORK" })),
    ).toEqual({ status: undefined, code: undefined, message: "x" });
    expect(
      extractAuthFailure(Object.assign(new Error("x"), { code: "TOKEN_INVALID" })),
    ).toEqual({ status: undefined, code: "TOKEN_INVALID", message: "x" });
  });
  it("handles null/empty", () => {
    expect(extractAuthFailure(null)).toEqual({
      status: undefined,
      code: undefined,
      message: undefined,
    });
  });
});

describe("predicates", () => {
  it("access-expired only on 401 + TOKEN_EXPIRED", () => {
    expect(isAccessExpired({ status: 401, code: "TOKEN_EXPIRED" })).toBe(true);
    expect(isAccessExpired({ status: 401, code: "REFRESH_FAILED" })).toBe(false);
    expect(isAccessExpired({ status: 403, code: "TOKEN_EXPIRED" })).toBe(false);
    expect(isAccessExpired({ status: 401 })).toBe(false);
  });
  it("session-dead covers every backend session code, never bare 401s", () => {
    for (const code of SESSION_DEAD_CODES) {
      expect(isSessionDead({ status: 401, code })).toBe(true);
    }
    expect(isSessionDead({ status: 403, code: "SESSION_EXPIRED" })).toBe(true);
    expect(isSessionDead({ status: 401 })).toBe(false);
    expect(isSessionDead({ status: 401, code: "TOKEN_EXPIRED" })).toBe(false);
    expect(isSessionDead({ status: 500, code: "REFRESH_FAILED" })).toBe(false);
    expect(isSessionDead({})).toBe(false);
  });
  it("skip marker detection", () => {
    expect(hasAuthRetrySkip({ [SKIP_AUTH_RETRY]: true })).toBe(true);
    expect(hasAuthRetrySkip({})).toBe(false);
    expect(hasAuthRetrySkip(undefined)).toBe(false);
  });
});

describe("refreshSession", () => {
  const setTokens = vi.fn();
  const cleared: boolean[] = [];
  let postImpl: (...args: any[]) => Promise<any>;
  let lastConfig: unknown;
  let mockHttp: any;

  beforeEach(() => {
    vi.clearAllMocks();
    cleared.length = 0;
    lastConfig = undefined;
    setAuthRefreshProvider(() => "rt-1");
    setAuthTokensProvider((at, rt) => setTokens(at, rt));
    setAuthClearProvider(() => cleared.push(true));
    postImpl = async () => ({ data: { access_token: "at-2", refresh_token: "rt-2" } });
    mockHttp = {
      get: vi.fn(async () => ({ data: null })),
      post: vi.fn(async (...a: any[]) => {
        lastConfig = a[2];
        return postImpl(...a);
      }),
      put: vi.fn(async () => ({ data: null })),
      patch: vi.fn(async () => ({ data: null })),
      delete: vi.fn(async () => ({ data: null })),
    };
    setHttpClient(mockHttp);
  });

  it("stores fresh tokens, sends skip marker", async () => {
    const tokens = await refreshSession();
    expect(tokens).toEqual({ access_token: "at-2", refresh_token: "rt-2" });
    expect(setTokens).toHaveBeenCalledWith("at-2", "rt-2");
    expect(hasAuthRetrySkip(lastConfig)).toBe(true);
    expect(cleared).toEqual([]);
  });

  it("refresh-expired from backend logs out", async () => {
    postImpl = async (..._a: any[]) => {
      throw axiosLike(401, "REFRESH_FAILED", "Token has expired");
    };
    const tokens = await refreshSession();
    expect(tokens).toBeNull();
    expect(cleared).toEqual([true]);
    expect(setTokens).not.toHaveBeenCalled();
  });

  it("network failure does not log out", async () => {
    postImpl = async (..._a: any[]) => {
      throw Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });
    };
    expect(await refreshSession()).toBeNull();
    expect(cleared).toEqual([]);
  });

  it("missing refresh token logs out", async () => {
    setAuthRefreshProvider(() => null);
    expect(await refreshSession()).toBeNull();
    expect(cleared).toEqual([true]);
  });

  it("single-flight under concurrency", async () => {
    let calls = 0;
    postImpl = async (..._a: any[]) => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { data: { access_token: "at-2", refresh_token: "rt-2" } };
    };
    const [a, b] = await Promise.all([refreshSession(), refreshSession()]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });
});

describe("withAuthRetry", () => {
  const cleared: boolean[] = [];
  beforeEach(() => {
    cleared.length = 0;
    setAuthRefreshProvider(() => "rt-1");
    setAuthTokensProvider(() => undefined);
    setAuthClearProvider(() => cleared.push(true));
    const mockHttp: any = {
      get: vi.fn(async () => ({ data: null })),
      post: vi.fn(async () => ({ data: { access_token: "at-2", refresh_token: "rt-2" } })),
      put: vi.fn(async () => ({ data: null })),
      patch: vi.fn(async () => ({ data: null })),
      delete: vi.fn(async () => ({ data: null })),
    };
    setHttpClient(mockHttp);
  });

  it("retries once after access-expired", async () => {
    let calls = 0;
    const v = await withAuthRetry(async () => {
      calls++;
      if (calls === 1) throw axiosLike(401, "TOKEN_EXPIRED", "Access token has expired");
      return "ok";
    });
    expect(v).toBe("ok");
    expect(calls).toBe(2);
    expect(cleared).toEqual([]);
  });

  it("rethows non-auth errors without refresh", async () => {
    let refreshCalls = 0;
    const mockHttp: any = {
      get: vi.fn(async () => ({ data: null })),
      post: vi.fn(async () => {
        refreshCalls++;
        return { data: { access_token: "a", refresh_token: "r" } };
      }),
      put: vi.fn(async () => ({ data: null })),
      patch: vi.fn(async () => ({ data: null })),
      delete: vi.fn(async () => ({ data: null })),
    };
    setHttpClient(mockHttp);
    await expect(
      withAuthRetry(async () => {
        throw axiosLike(500, "SERVER_ERROR", "boom");
      }),
    ).rejects.toThrow("boom");
    expect(refreshCalls).toBe(0);
  });

  it("dead refresh surfaces original error after logout", async () => {
    const mockHttp: any = {
      get: vi.fn(async () => ({ data: null })),
      post: vi.fn(async () => {
        throw axiosLike(401, "REFRESH_FAILED", "Token has expired");
      }),
      put: vi.fn(async () => ({ data: null })),
      patch: vi.fn(async () => ({ data: null })),
      delete: vi.fn(async () => ({ data: null })),
    };
    setHttpClient(mockHttp);
    await expect(
      withAuthRetry(async () => {
        throw axiosLike(401, "TOKEN_EXPIRED", "Access token has expired");
      }),
    ).rejects.toThrow("Access token has expired");
    expect(cleared).toEqual([true]);
  });
});
