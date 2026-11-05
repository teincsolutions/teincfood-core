/**
 * Migration fidelity — the engine outbox (commands) and event journal
 * (events) must exist after running the REAL migration chain on a real
 * SQLite database. v8 dropped them as "legacy" while the code still depends
 * on them; v9 recreates them. This test pins the contract so no future
 * migration can silently drop a table the sync system writes to.
 *
 * Uses node:sqlite (real engine) instead of the memory driver on purpose:
 * the memory driver hardcodes tables and masked the v8 drop.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { MIGRATIONS } from "./migrations";
import type { SqliteDriver } from "../adapters/sqlite";

function nodeDriver(db: DatabaseSync): SqliteDriver {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql);
    },
    runAsync: async (sql: string, ...args: unknown[]) => {
      const info = (db.prepare(sql).run(...(args as SQLInputValue[])) as unknown as Record<string, unknown>);
      const lastId = info.lastInsertRowId ?? info.lastInsertRowid ?? 0;
      return { lastInsertRowId: Number(lastId), changes: Number(info.changes) };
    },
    getFirstAsync: async <T>(sql: string, ...args: unknown[]): Promise<T | null> => {
      const row = db.prepare(sql).get(...(args as SQLInputValue[]));
      return (row as T) ?? null;
    },
    getAllAsync: async <T>(sql: string, ...args: unknown[]): Promise<T[]> => {
      return db.prepare(sql).all(...(args as SQLInputValue[])) as T[];
    },
  };
}

async function migrateFresh(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  const drv = nodeDriver(db);
  await drv.execAsync(
    "CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);",
  );
  for (const m of MIGRATIONS) {
    const row = await drv.getFirstAsync<{ version: number }>(
      "SELECT version FROM migrations WHERE version = ?;",
      m.version,
    );
    if (row) continue;
    await m.up(drv);
    await drv.runAsync("INSERT INTO migrations (version, applied_at) VALUES (?, ?);", m.version, new Date().toISOString());
  }
  return db;
}

function tables(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe("migrations fidelity", () => {
  it("fresh chain leaves every table the sync system writes", async () => {
    const db = migrateFresh ? await migrateFresh() : null;
    const names = tables(db!);
    for (const t of ["commands", "events", "orders", "sync_jobs", "reference_data", "entity_snapshots", "migrations"]) {
      expect(names).toContain(t);
    }
    db!.close();
  });

  it("v9 heals a DB that ran v8 (commands/events recreated, data kept)", async () => {
    const db = new DatabaseSync(":memory:");
    const drv = nodeDriver(db);
    await drv.execAsync(
      "CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);",
    );
    // Run only up to v8 (the drop), seed an order, then run the rest.
    for (const m of MIGRATIONS) {
      if (m.version > 8) break;
      await m.up(drv);
      await drv.runAsync("INSERT INTO migrations (version, applied_at) VALUES (?, ?);", m.version, new Date().toISOString());
    }
    expect(tables(db)).not.toContain("commands");
    await drv.runAsync(
      "INSERT INTO orders (id, business_id, order_number, status, items, subtotal_minor, total_minor, inserted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
      "o1",
      "biz",
      "07-111-001",
      "accepted",
      "[]",
      0,
      0,
      new Date().toISOString(),
    );
    for (const m of MIGRATIONS) {
      // Stop before v14: that migration intentionally clears local data for
      // the DD-NNNN-MMM cutover.
      if (m.version <= 8 || m.version >= 14) continue;
      await m.up(drv);
      await drv.runAsync("INSERT INTO migrations (version, applied_at) VALUES (?, ?);", m.version, new Date().toISOString());
    }
    expect(tables(db)).toContain("commands");
    expect(tables(db)).toContain("events");
    // pre-existing data survives the v8/v9 heal
    const row = db.prepare("SELECT id FROM orders WHERE id='o1';").get() as { id: string } | undefined;
    expect(row?.id).toBe("o1");
    // and the restored tables are writable
    await drv.runAsync(
      "INSERT INTO commands (command_id, command_type, command_version, business_id, user_id, device_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);",
      "c1",
      "order:create",
      "1.0",
      "biz",
      "u",
      "d",
      "{}",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    db.close();
  });

  it("v14 clears local orders and sync state for a fresh login", async () => {
    const db = await migrateFresh();
    const drv = nodeDriver(db);
    const now = new Date().toISOString();

    await drv.runAsync(
      "INSERT INTO orders (id, business_id, order_number, status, items, subtotal_minor, total_minor, inserted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
      "o1", "biz", "07-100-001", "accepted", "[]", 0, 0, now,
    );
    await drv.runAsync(
      "INSERT INTO commands (command_id, command_type, command_version, business_id, user_id, device_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);",
      "c1", "order:create", "1.0", "biz", "u", "d", "{}", now, now,
    );
    await drv.runAsync(
      "INSERT INTO events (event_id, event_type, event_version, entity_id, user_id, device_id, payload, origin, timestamp, persisted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
      "e1", "order.create_queued", "1.0", "o1", "u", "d", "{}", "local", now, now,
    );
    await drv.runAsync(
      "INSERT INTO sync_jobs (id, business_id, command_type, entity_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?);",
      "j1", "biz", "order:create", "o1", "{}", now, now,
    );
    await drv.runAsync(
      "INSERT INTO entity_snapshots (entity_type, entity_id, business_id, last_event_id, last_event_timestamp, payload) VALUES (?, ?, ?, ?, ?, ?);",
      "seller_orders", "list-main", "biz", "e1", now, "{}",
    );
    await drv.runAsync(
      "INSERT INTO reference_data (business_id, key, version, payload, downloaded_at) VALUES (?, ?, ?, ?, ?);",
      "biz", "business:profile", "v1", "{}", now,
    );

    const v14 = MIGRATIONS.find((m) => m.version === 14)!;
    await v14.up(drv);

    for (const table of ["orders", "commands", "events", "sync_jobs", "entity_snapshots", "reference_data"]) {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table};`).get() as { c: number };
      expect(row.c).toBe(0);
    }
    db.close();
  });
});
