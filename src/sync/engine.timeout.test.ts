import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { setConnectivityState } from "../adapters/connectivity";
import { setAuthProvider } from "../adapters/auth";
import { syncEngine } from "./engine";
import { restTransport } from "./transport-rest";
import { localNodeTransport } from "./transport-local-node";
import { commandQueueService } from "./command-queue.service";
import { TRANSITION_ERROR_CODES, TransitionError } from "./transition-errors";
import type { Command, DomainEvent } from "./types";

const { guardMock } = vi.hoisted(() => ({ guardMock: vi.fn() }));
vi.mock("../reference/entitlement-guard", () => ({
  assertEntitledForCommand: guardMock,
}));

const BID = "biz-engine-timeout";

function cashOrderCommand(): Command {
  return {
    command_id: "cmd-engine-timeout-1",
    command_type: "order:create",
    command_version: "1.0",
    business_id: BID,
    entity_id: "22222222-2222-4222-8222-222222222222",
    user_id: "u1",
    device_id: "d1",
    timestamp: new Date().toISOString(),
    payload: {
      order_type: "takeout",
      pos_payment_method: "cash",
      total_minor: 5000,
      items: [],
      item_snapshots: [],
    },
  };
}

function queuedEvent(command: Command): DomainEvent {
  return {
    event_id: "evt-1",
    event_type: "order.create_queued",
    event_version: "1.0",
    entity_id: command.entity_id ?? command.command_id,
    user_id: command.user_id,
    device_id: command.device_id,
    payload: { ...(command.payload as Record<string, unknown>) },
    timestamp: new Date().toISOString(),
  };
}

describe("SyncEngine bounded attempts (offline-first hang fix)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    guardMock.mockReset().mockResolvedValue(undefined);
    setAuthProvider(() => "token-123");
    setConnectivityState({ isOnline: true, isCloudReachable: "reachable" });
  });

  afterEach(() => {
    setConnectivityState({ isOnline: true, isCloudReachable: "unknown" });
  });

  it("dead cloud under a stale reachable belief: one capped attempt, then queue", async () => {
    // Backend is down but the probe has not flipped the flag yet — the exact
    // hang scenario: the old code re-entered cloud uncapped (OS TCP timeout).
    const hanging = vi
      .spyOn(restTransport, "execute")
      .mockImplementation(() => new Promise(() => {}));
    vi.spyOn(localNodeTransport, "isAvailable").mockReturnValue(false);
    const enqueue = vi
      .spyOn(commandQueueService, "enqueue")
      .mockImplementation(async (command: Command) => queuedEvent(command));

    const started = Date.now();
    const events = await syncEngine.execute(cashOrderCommand());
    const elapsed = Date.now() - started;

    expect(hanging).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    // 2.5s cloud cap + margin — never the minutes-long OS timeout.
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it("replay preserves a server error instead of claiming no transport", async () => {
    const serverError = Object.assign(new Error("Internal Server Error"), {
      status: 500,
    });
    vi.spyOn(restTransport, "execute").mockRejectedValue(serverError);
    vi.spyOn(localNodeTransport, "isAvailable").mockReturnValue(false);

    await expect(
      syncEngine.execute(cashOrderCommand(), { forReplay: true }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("queues cash orders despite entitlement failure, flagged for the UI", async () => {
    guardMock.mockRejectedValue(
      new TransitionError(TRANSITION_ERROR_CODES.SUBSCRIPTION_REQUIRED, "no proof"),
    );
    setConnectivityState({ isOnline: false, isCloudReachable: "unreachable" });
    vi.spyOn(localNodeTransport, "isAvailable").mockReturnValue(false);
    vi.spyOn(commandQueueService, "enqueue").mockImplementation(async (command: Command) =>
      queuedEvent(command),
    );

    const events = await syncEngine.execute(cashOrderCommand());
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>).entitlement_unverified).toBe(true);
  });

  it("non-cash orders still throw on entitlement failure", async () => {
    guardMock.mockRejectedValue(
      new TransitionError(TRANSITION_ERROR_CODES.SUBSCRIPTION_REQUIRED, "no proof"),
    );
    const command = { ...cashOrderCommand(), payload: { pos_payment_method: "mobile_money" } };
    await expect(syncEngine.execute(command)).rejects.toMatchObject({
      code: TRANSITION_ERROR_CODES.SUBSCRIPTION_REQUIRED,
    });
  });
});
