import { beforeEach, describe, expect, it, vi } from "vitest";
import { setKVDriver, setItemSync } from "../adapters/kv";
import { setConnectivityState } from "../adapters/connectivity";
import { setAuthProvider } from "../adapters/auth";
import { setAppInstanceId } from "../adapters/devices";
import { setHttpClient, type HttpClient } from "../adapters/http";
import {
  classifyDeviceLeaseFailure,
  clearLeaseForTests,
  ensureLease,
  getLastLeaseFailure,
} from "./device-lease.service";

const BID = "biz-device-lease-test";

function httpClient(overrides: Partial<HttpClient> = {}): HttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}

describe("device lease failures", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    setKVDriver({
      getItem: async (key: string) => store.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: async (key: string) => {
        store.delete(key);
      },
      getItemSync: (key: string) => store.get(key) ?? null,
      setItemSync: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItemSync: (key: string) => {
        store.delete(key);
      },
    } as never);
    setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });
    setAuthProvider(() => "test-token");
    setAppInstanceId("device-lease-test-uuid-1234");
    clearLeaseForTests(BID);
  });

  it("keeps the backend terminal-limit reason and details", async () => {
    setHttpClient(
      httpClient({
        post: vi.fn().mockRejectedValue({
          status: 402,
          message:
            "Your plan allows 1 linked terminal. 1 already linked. Remove an old terminal or upgrade your plan.",
          data: {
            error: {
              code: "TERMINAL_LIMIT_REACHED",
              message:
                "Your plan allows 1 linked terminal. 1 already linked. Remove an old terminal or upgrade your plan.",
              details: { limit: 1, current: 1 },
            },
          },
        }),
      }),
    );

    await expect(ensureLease(BID)).resolves.toBeNull();
    expect(getLastLeaseFailure(BID)).toMatchObject({
      code: "TERMINAL_LIMIT_REACHED",
      limit: 1,
      current: 1,
      status: 402,
    });
  });

  it("classifies 429 device-limit responses separately", () => {
    expect(
      classifyDeviceLeaseFailure({
        status: 429,
        data: {
          error: {
            code: "DEVICE_LIMIT_REACHED",
            message: "99 devices max",
          },
        },
      }),
    ).toMatchObject({ code: "DEVICE_LIMIT_REACHED", status: 429 });
  });

  it("clears a previous failure when a cached lease is available", async () => {
    await ensureLease(BID).catch(() => null);
    setHttpClient(
      httpClient({
        post: vi.fn().mockRejectedValue({
          status: 402,
          data: { error: { code: "TERMINAL_LIMIT_REACHED", message: "Limit" } },
        }),
      }),
    );
    await ensureLease(BID);

    setItemSync(`teinc_device_number:${BID}`, "07");
    setItemSync(`teinc_device_number:${BID}:leased_at`, new Date().toISOString());

    await expect(ensureLease(BID)).resolves.toBe("07");
    expect(getLastLeaseFailure(BID)).toBeNull();
  });
});
