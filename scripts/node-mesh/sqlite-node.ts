/**
 * Node-native SQLite driver for the mesh harness (node:sqlite, in-memory).
 * Gives the harness a REAL sync database: migrations run, orders persist,
 * guards evaluate — so order:sync create/transition flows run production code.
 */
import { DatabaseSync } from "node:sqlite";
import { setSqliteDriver } from "../../src/adapters/sqlite";
import { setItemSync } from "../../src/adapters/kv";
import { openSyncDatabase } from "../../src/db/connection";
import { setReferenceData } from "../../src/reference/operations";

export function installNodeSqlite(): void {
  const db = new DatabaseSync(":memory:");
  setSqliteDriver({
    execAsync: async (sql: string) => {
      db.exec(sql);
    },
    runAsync: async (sql: string, ...args: unknown[]) => {
      const info = db.prepare(sql).run(...(args as unknown[])) as unknown as Record<string, unknown>;
      const lastId = info.lastInsertRowId ?? info.lastInsertRowid ?? 0;
      return {
        lastInsertRowId: Number(lastId),
        changes: Number(info.changes),
      };
    },
    getFirstAsync: async <T>(sql: string, ...args: unknown[]): Promise<T | null> => {
      const row = db.prepare(sql).get(...(args as unknown[]));
      return (row as T) ?? null;
    },
    getAllAsync: async <T>(sql: string, ...args: unknown[]): Promise<T[]> => {
      return db.prepare(sql).all(...(args as unknown[])) as T[];
    },
    withTransactionAsync: async (fn: () => Promise<void>) => {
      db.exec("BEGIN");
      try {
        await fn();
        db.exec("COMMIT");
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw e;
      }
    },
  });
}

/**
 * Seed per-process prerequisites for offline order flow:
 * - DD lease in KV (backend lease authority; harness stands in for "leased once online")
 * - operating-hours 24/7 so the fail-closed business-hours guard passes offline
 */
export async function seedHarness(businessId: string, dd: string): Promise<void> {
  setItemSync(`teinc_device_number:${businessId}`, dd);
  const db = await openSyncDatabase();
  const now = new Date().toISOString();
  const hours = [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
    day_of_week,
    open_time: "00:00:00",
    close_time: "23:59:59",
    is_closed: false,
  }));
  await setReferenceData(db, businessId, {
    key: "operating-hours",
    version: "harness-1",
    payload: hours,
    downloadedAt: now,
    lastEventId: null,
    lastHlc: null,
  });
}
