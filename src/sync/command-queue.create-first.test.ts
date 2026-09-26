import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { setKVDriver } from "../adapters/kv";
import { setAuthProvider } from "../adapters/auth";
import { setActiveBusiness } from "../adapters/business";
import { setHttpClient } from "../adapters/http";
import { openSyncDatabase, closeSyncDatabase, getSyncDatabase } from "../db/connection";
import { insertCommand, getPendingCommands, insertOrder, getOrderById, updateCommandStatus } from "../db/operations";
import { commandQueueService } from "./command-queue.service";
import { TRANSITION_ERROR_CODES } from "./transition-errors";
import type { Command, PersistedCommand } from "./types";

const { notifyErrorMock } = vi.hoisted(() => ({ notifyErrorMock: vi.fn() }));
vi.mock("../adapters/notify", () => ({ notifyError: notifyErrorMock }));

const BID = "biz-create-first-test";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";

function transitionCommand(): Command {
  return {
    command_id: `cmd-${Math.random().toString(36).slice(2)}`,
    command_type: "order:mark_ready",
    command_version: "1.0",
    business_id: BID,
    entity_id: ORDER_ID,
    user_id: "u1",
    device_id: "d1",
    timestamp: new Date().toISOString(),
    payload: { action: "mark_ready", orderId: ORDER_ID },
  };
}

function createCommand(): Command {
  return {
    command_id: `cmd-create-${Math.random().toString(36).slice(2)}`,
    command_type: "order:create",
    command_version: "1.0",
    business_id: BID,
    entity_id: ORDER_ID,
    user_id: "u1",
    device_id: "d1",
    timestamp: new Date().toISOString(),
    payload: { id: ORDER_ID, command_id: ORDER_ID, order_number: "07-001-002" },
  };
}

function api404(): unknown {
  const err = new Error("Resource not found") as unknown as Record<string, unknown>;
  err.status = 404;
  err.response = { status: 404, data: { error: { code: "NOT_FOUND", message: "Resource not found" } } };
  return err;
}

function api400(): unknown {
  const err = new Error("Validation failed") as unknown as Record<string, unknown>;
  err.status = 400;
  err.response = { status: 400, data: { error: { code: "VALIDATION_ERROR", message: "Validation failed" } } };
  return err;
}

function localOrder(status: string, updatedAt?: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: ORDER_ID,
    business_id: BID,
    order_number: "07-001-002",
    callout_number: 2,
    status,
    order_type: "takeout",
    is_pos: 1,
    items: "[]",
    subtotal_minor: 5000,
    total_minor: 5000,
    tax_minor: 0,
    tax_lines: "[]",
    payment: "{}",
    customer_name: null,
    customer_phone: null,
    pos_payment_method: "cash",
    delivery_id: null,
    business: null,
    user: null,
    inserted_at: now,
    updated_at: updatedAt ?? now,
  };
}

describe("command-queue create-before-transition", () => {
  let executeMock: ReturnType<typeof vi.fn>;
  let serverStatus: string;

  beforeEach(async () => {
    notifyErrorMock.mockReset();
    const mem = createMemoryDriver();
    setSqliteDriver(mem as never);
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
    const db = await openSyncDatabase();
    setAuthProvider(() => "token-123");
    setActiveBusiness({ id: BID } as never);
    serverStatus = "accepted";
    const serverUpdatedAt = new Date(Date.now() + 60_000).toISOString();
    setHttpClient({
      get: vi.fn(async (url: string) => {
        if (url.includes(`/businesses/${BID}/orders`)) {
          return { data: { data: [{ ...localOrder(serverStatus, serverUpdatedAt) }], pagination: { total_pages: 1 } } };
        }
        return { data: { data: [] } };
      }),
      post: vi.fn(async () => ({ data: {} })),
    } as never);
    executeMock = vi.fn();
    commandQueueService.setSyncEngine({ execute: executeMock } as never);
  });

  async function seedCommand(cmd: Command, status: "pending" | "failed" = "pending"): Promise<PersistedCommand> {
    const db = await openSyncDatabase();
    return insertCommand(db, { command: cmd, status });
  }

  async function seedOrder(status: string): Promise<void> {
    const db = await openSyncDatabase();
    await insertOrder(db, localOrder(status) as never);
  }

  async function orderSyncFailedAt(): Promise<string | null> {
    const db = await openSyncDatabase();
    const order = await getOrderById(db, BID, ORDER_ID);
    return (order as unknown as { sync_failed_at?: string | null })?.sync_failed_at ?? null;
  }

  it("404 on a transition dead-letters immediately (no retry loop) and flags the order", async () => {
    await seedOrder("accepted");
    const row = await seedCommand(transitionCommand());
    executeMock.mockRejectedValue(api404());

    await commandQueueService.processCommand(row);

    const db = await openSyncDatabase();
    const after = (await getPendingCommands(db, 100, true)).find((c) => c.command_id === row.command_id);
    expect(after?.status).toBe("failed");
    expect(after?.retry_count).toBe(1);
    expect(notifyErrorMock).toHaveBeenCalledTimes(1);
    expect(await orderSyncFailedAt()).toBeTruthy();
    // Fast-fail: only the one attempt, never the 8-attempt 4xx budget.
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("404 that absorbs (server already at target) completes instead of failing", async () => {
    await seedOrder("accepted");
    serverStatus = "ready";
    const row = await seedCommand(transitionCommand());
    executeMock.mockRejectedValue(api404());

    await commandQueueService.processCommand(row);

    const db = await openSyncDatabase();
    expect(await getPendingCommands(db, 100)).toHaveLength(0);
    expect(notifyErrorMock).not.toHaveBeenCalled();
    expect(await orderSyncFailedAt()).toBeNull();
  });

  it("defers a transition when its order:create is still pending (never POSTs)", async () => {
    await seedOrder("accepted");
    await seedCommand(createCommand());
    const row = await seedCommand(transitionCommand());

    await expect(commandQueueService.processCommand(row)).rejects.toMatchObject({
      code: TRANSITION_ERROR_CODES.REPLAY_DEFERRED,
    });
    expect(executeMock).not.toHaveBeenCalled();
    const db = await openSyncDatabase();
    const after = (await getPendingCommands(db, 100)).find((c) => c.command_id === row.command_id);
    expect(after?.status).toBe("pending");
  });

  it("fails a transition whose order:create already dead-lettered", async () => {
    await seedOrder("accepted");
    await seedCommand(createCommand(), "failed");
    const row = await seedCommand(transitionCommand());

    await commandQueueService.processCommand(row);

    expect(executeMock).not.toHaveBeenCalled();
    const db = await openSyncDatabase();
    const after = (await getPendingCommands(db, 100, true)).find((c) => c.command_id === row.command_id);
    expect(after?.status).toBe("failed");
    expect(await orderSyncFailedAt()).toBeTruthy();
  });

  it("cascades: an exhausted order:create fails its queued transitions", async () => {
    await seedOrder("accepted");
    const create = await seedCommand(createCommand());
    const transition = await seedCommand(transitionCommand());
    const db = getSyncDatabase();
    for (let i = 0; i < 7; i++) {
      await db.runAsync(
        `UPDATE commands SET status = ?, error = ?, retry_count = retry_count + 1, updated_at = ? WHERE command_id = ?;`,
        "pending",
        null,
        new Date().toISOString(),
        create.command_id,
      );
    }
    const seededCreate = (await getPendingCommands(db, 100)).find((c) => c.command_id === create.command_id)!;
    executeMock.mockRejectedValue(api400());

    await commandQueueService.processCommand(seededCreate);

    const after = await getPendingCommands(db, 100, true);
    expect(after.find((c) => c.command_id === create.command_id)?.status).toBe("failed");
    expect(after.find((c) => c.command_id === transition.command_id)?.status).toBe("failed");
    expect(await orderSyncFailedAt()).toBeTruthy();
  });

  it("orderCreateGate reports pending / failed / none", async () => {
    expect(await commandQueueService.orderCreateGate(BID, ORDER_ID)).toBe("none");
    const create = await seedCommand(createCommand());
    expect(await commandQueueService.orderCreateGate(BID, ORDER_ID)).toBe("pending");
    const db = await openSyncDatabase();
    await updateCommandStatus(db, create.command_id, "failed", "test");
    expect(await commandQueueService.orderCreateGate(BID, ORDER_ID)).toBe("failed");
  });
});
