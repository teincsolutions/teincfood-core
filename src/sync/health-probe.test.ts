import { describe, it, expect, beforeEach, vi } from "vitest";

const { getHttpClientMock, getActiveBusinessMock, getAuthTokenMock } = vi.hoisted(() => ({
  getHttpClientMock: vi.fn(),
  getActiveBusinessMock: vi.fn(),
  getAuthTokenMock: vi.fn(),
}));
vi.mock("../adapters/http", () => ({ getHttpClient: getHttpClientMock }));
vi.mock("../adapters/business", () => ({ getActiveBusiness: getActiveBusinessMock }));
vi.mock("../adapters/auth", () => ({ getAuthToken: getAuthTokenMock }));

import { setConnectivityState, getConnectivityState } from "../adapters/connectivity";
import { probeCloudHealth } from "./health-probe";

describe("health probe owns the reachability flag", () => {
  beforeEach(() => {
    getHttpClientMock.mockReset();
    getActiveBusinessMock.mockReset();
    getAuthTokenMock.mockReset();
    getActiveBusinessMock.mockReturnValue(null);
    getAuthTokenMock.mockReturnValue(null);
    setConnectivityState({ isOnline: true, isCloudReachable: "unknown" });
  });

  it("success marks reachable", async () => {
    getHttpClientMock.mockReturnValue({ get: vi.fn(async () => ({ data: {} })) });
    await expect(probeCloudHealth()).resolves.toBe(true);
    expect(getConnectivityState().isCloudReachable).toBe("reachable");
  });

  it("failure marks unreachable (sole writer rule)", async () => {
    getHttpClientMock.mockReturnValue({
      get: vi.fn(async () => { throw new Error("socket hang up"); }),
    });
    await expect(probeCloudHealth()).resolves.toBe(false);
    expect(getConnectivityState().isCloudReachable).toBe("unreachable");
  });

  it("offline device never touches the flag", async () => {
    setConnectivityState({ isOnline: false, isCloudReachable: "reachable" });
    getHttpClientMock.mockReturnValue({ get: vi.fn(async () => ({ data: {} })) });
    await expect(probeCloudHealth()).resolves.toBe(false);
    expect(getConnectivityState().isCloudReachable).toBe("reachable");
  });
});
