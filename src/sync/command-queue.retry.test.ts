import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDriver } from "../test-helpers/memory-driver";
import { setSqliteDriver } from "../adapters/sqlite";
import { setKVDriver } from "../adapters/kv";
import { setAuthProvider } from "../adapters/auth";
import { setActiveBusiness } from "../adapters/business";
import { setHttpClient } from "../adapters/http";
import { openSyncDatabase, closeSyncDatabase, getSyncDatabase } from "../db/connection";
import { insertCommand, getPendingCommands, insertOrder } from "../db/operations";
import { commandQueueService } from "./command-queue.service";
import { TRANSITION_ERROR_CODES } from "./transition-errors";
import type { Command, PersistedCommand } from "./types";

const { notifyErrorMock } = vi.hoisted(() => ({ notifyErrorMock: vi.fn() }));
vi.mock("../adapters/notify", () => ({ notifyError: notifyErrorMock }));

const BID = "biz-retry-test";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";

function markReadyCommand(): Command {
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

function api422(): unknown {
  const err = new Error("Cannot mark_ready from accepted") as unknown as Record<string, unknown>;
  err.status = 422;
  err.response = { status: 422, data: { error: { code: "INVALID_TRANSITION", message: "Cannot mark_ready from accepted" } } };
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
    order_number: "07-001-001",
    callout_number: 1,
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

describe("command-queue bounded 4xx retry + absorb", () => {
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
    await openSyncDatabase();
    setAuthProvider(() => "token-123");
    setActiveBusiness({ id: BID } as never);
    serverStatus = "accepted";
    // Server copy is strictly newer so the memory driver's hlc mapping
    // (hlc <- updated_at) registers the pull as touching the row.
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

  async function seedCommand(cmd: Command): Promise<PersistedCommand> {
    const db = await openSyncDatabase();
    return insertCommand(db, { command: cmd, status: "pending" });
  }

  async function seedOrder(status: string): Promise<void> {
    const db = await openSyncDatabase();
    await insertOrder(db, localOrder(status) as never);
  }

  it("422 FIFO race stays pending with backoff and defers replay (no instant fail)", async () => {
    await seedOrder("accepted");
    const row = await seedCommand(markReadyCommand());
    executeMock.mockRejectedValue(api422());
    await expect(commandQueueService.processCommand(row)).rejects.toMatchObject({
      code: TRANSITION_ERROR_CODES.REPLAY_DEFERRED,
    });
    const db = await openSyncDatabase();
    const pending = await getPendingCommands(db, 100);
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("pending");
    expect(pending[0].retry_count).toBe(1);
    expect(pending[0].error ?? "").toMatch(/^retry_4xx:/);
    expect(notifyErrorMock).not.toHaveBeenCalled();
  });

  it("second replay inside backoff defers without hitting the engine", async () => {
    await seedOrder("accepted");
    const row = await seedCommand(markReadyCommand());
    executeMock.mockRejectedValue(api422());
    await expect(commandQueueService.processCommand(row)).rejects.toMatchObject({
      code: TRANSITION_ERROR_CODES.REPLAY_DEFERRED,
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
    const db = await openSyncDatabase();
    const again = (await getPendingCommands(db, 100))[0];
    await expect(commandQueueService.processCommand(again)).rejects.toMatchObject({
      code: TRANSITION_ERROR_CODES.REPLAY_DEFERRED,
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("5th retryable attempt fails loudly with a toast", async () => {
    await seedOrder("accepted");
    const row = await seedCommand(markReadyCommand());
    const db = getSyncDatabase();
    // retry_count only increments through the driver's matched UPDATE shape.
    for (let i = 0; i < 4; i++) {
      await db.runAsync(
        `UPDATE commands SET status = ?, error = ?, retry_count = retry_count + 1, updated_at = ? WHERE command_id = ?;`,
        "pending",
        null,
        new Date().toISOString(),
        row.command_id,
      );
    }
    const seeded = (await getPendingCommands(db, 100))[0];
    expect(seeded.retry_count).toBe(4);
    executeMock.mockRejectedValue(api422());
    await commandQueueService.processCommand(seeded);
    const after = (await getPendingCommands(db, 100, true)).find((c) => c.command_id === row.command_id);
    expect(after?.status).toBe("failed");
    expect(notifyErrorMock).toHaveBeenCalledTimes(1);
  });

  it("absorbs when the server is already at the target status", async () => {
    await seedOrder("accepted");
    serverStatus = "ready";
    const row = await seedCommand(markReadyCommand());
    executeMock.mockRejectedValue(api422());
    await commandQueueService.processCommand(row);
    const db = await openSyncDatabase();
    expect(await getPendingCommands(db, 100)).toHaveLength(0);
    expect(notifyErrorMock).not.toHaveBeenCalled();
  });

  it("permanent 400 fails immediately with a toast", async () => {
    await seedOrder("accepted");
    const row = await seedCommand(markReadyCommand());
    executeMock.mockRejectedValue(api400());
    await commandQueueService.processCommand(row);
    const db = await openSyncDatabase();
    const after = (await getPendingCommands(db, 100, true)).find((c) => c.command_id === row.command_id);
    expect(after?.status).toBe("failed");
    expect(notifyErrorMock).toHaveBeenCalledTimes(1);
  });
});
