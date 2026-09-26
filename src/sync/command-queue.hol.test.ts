import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { setKVDriver } from "../adapters/kv";
import { setAuthProvider } from "../adapters/auth";
import { setActiveBusiness } from "../adapters/business";
import { openSyncDatabase, closeSyncDatabase, getSyncDatabase } from "../db/connection";
import { insertCommand, getPendingCommands } from "../db/operations";
import { commandQueueService } from "./command-queue.service";
import { TransitionError, TRANSITION_ERROR_CODES } from "./transition-errors";
import type { Command } from "./types";

const BID = "biz-hol-test";

function uuid(n: number): string {
  return `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;
}

function createCommand(entityId: string): Command {
  return {
    command_id: `cmd-${entityId}-create`,
    command_type: "order:create",
    command_version: "1.0",
    business_id: BID,
    entity_id: entityId,
    user_id: "u1",
    device_id: "d1",
    timestamp: new Date().toISOString(),
    payload: { order_number: "07-001-001", items: [] },
  };
}

function transitionCommand(entityId: string): Command {
  return {
    command_id: `cmd-${entityId}-mark_ready`,
    command_type: "order:mark_ready",
    command_version: "1.0",
    business_id: BID,
    entity_id: entityId,
    user_id: "u1",
    device_id: "d1",
    timestamp: new Date().toISOString(),
    payload: { action: "mark_ready", orderId: entityId },
  };
}

function networkError(): unknown {
  return new Error("socket hang up");
}

function noTransportError(): unknown {
  return new TransitionError(
    TRANSITION_ERROR_CODES.REPLAY_NO_TRANSPORT,
    "No transport available, keeping command queued",
  );
}

function eventsFor(command: Command) {
  return [
    {
      event_id: `evt-${command.command_id}`,
      event_type: `${command.command_type.replace(":", ".")}_done`,
      event_version: "1.0",
      entity_id: command.entity_id ?? command.command_id,
      user_id: command.user_id,
      device_id: command.device_id,
      payload: {},
      timestamp: new Date().toISOString(),
    },
  ];
}

describe("command-queue replay head-of-line isolation", () => {
  let executeMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    setSqliteDriver(createMemoryDriver() as never);
    const kvStore = new Map<string, string>();
    setKVDriver({
      getItem: async (k: string) => kvStore.get(k) ?? null,
      setItem: async (k: string, v: string) => { kvStore.set(k, v); },
      removeItem: async (k: string) => { kvStore.delete(k); },
      getItemSync: (k: string) => kvStore.get(k) ?? null,
      setItemSync: (k: string, v: string) => { kvStore.set(k, v); },
      removeItemSync: (k: string) => { kvStore.delete(k); },
    } as never);
    try { await closeSyncDatabase(); } catch {}
    await openSyncDatabase();
    setAuthProvider(() => "token-123");
    setActiveBusiness({ id: BID } as never);
    executeMock = vi.fn(async (command: Command) => eventsFor(command));
    commandQueueService.setSyncEngine({ execute: executeMock } as never);
  });

  async function seed(cmd: Command, status: "pending" | "failed" | "in_flight" = "pending") {
    const db = await openSyncDatabase();
    return insertCommand(db, { command: cmd, status });
  }

  it("a failed head does not block independent entities (skip-and-continue)", async () => {
    const a = uuid(1);
    const b = uuid(2);
    await seed(createCommand(a));
    await seed(createCommand(b));
    executeMock.mockImplementation(async (command: Command) => {
      if (command.entity_id === a) throw networkError();
      return eventsFor(command);
    });

    await commandQueueService.replay();

    const db = await openSyncDatabase();
    const pending = await getPendingCommands(db, 100);
    // B synced (deleted); A remains pending.
    expect(pending.map((c) => c.entity_id)).toEqual([a]);
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("keeps same-entity transitions queued behind a deferred create", async () => {
    const a = uuid(1);
    const b = uuid(2);
    await seed(createCommand(a));
    await seed(transitionCommand(a)); // same entity, must wait behind create
    await seed(createCommand(b));
    executeMock.mockImplementation(async (command: Command) => {
      if (command.entity_id === a) throw networkError();
      return eventsFor(command);
    });

    await commandQueueService.replay();

    const db = await openSyncDatabase();
    const pending = await getPendingCommands(db, 100);
    expect(pending.map((c) => c.entity_id).sort()).toEqual([a, a]);
    // Only create(a) and create(b) attempted — transition(a) skipped.
    expect(executeMock).toHaveBeenCalledTimes(2);
    const attempted = executeMock.mock.calls.map((c) => (c[0] as Command).command_id);
    expect(attempted).not.toContain(`cmd-${a}-mark_ready`);
  });

  it("stops the whole pass when no transport is available", async () => {
    await seed(createCommand(uuid(1)));
    await seed(createCommand(uuid(2)));
    executeMock.mockRejectedValue(noTransportError());

    await commandQueueService.replay();

    const db = await openSyncDatabase();
    expect(await getPendingCommands(db, 100)).toHaveLength(2);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("trips the transport breaker after 3 consecutive network failures", async () => {
    for (let i = 1; i <= 5; i++) await seed(createCommand(uuid(i)));
    executeMock.mockRejectedValue(networkError());

    await commandQueueService.replay();

    const db = await openSyncDatabase();
    expect(await getPendingCommands(db, 100)).toHaveLength(5);
    // 3 attempted, breaker tripped, remaining 2 untouched.
    expect(executeMock).toHaveBeenCalledTimes(3);
  });

  it("does not replay terminal (failed) commands", async () => {
    await seed(createCommand(uuid(1)), "failed");
    await seed(createCommand(uuid(2)));

    await commandQueueService.replay();

    const db = await openSyncDatabase();
    // The failed row is never fetched or re-attempted; only the pending one
    // synced (and was deleted on success).
    expect(await getPendingCommands(db, 100)).toHaveLength(0);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect((executeMock.mock.calls[0][0] as Command).entity_id).toBe(uuid(2));
  });

  it("recovers in-flight commands to pending on database open", async () => {
    const entity = uuid(1);
    const row = await seed(createCommand(entity), "in_flight");
    const db = getSyncDatabase();
    const before = await db.getFirstAsync<{ status: string }>(
      "SELECT * FROM commands WHERE id = ?;",
      row.id,
    );
    expect(before?.status).toBe("in_flight");

    await closeSyncDatabase();
    await openSyncDatabase();

    const reopened = getSyncDatabase();
    const after = await reopened.getFirstAsync<{ status: string }>(
      "SELECT * FROM commands WHERE id = ?;",
      row.id,
    );
    expect(after?.status).toBe("pending");
    expect(await getPendingCommands(reopened, 100)).toHaveLength(1);
  });
});
