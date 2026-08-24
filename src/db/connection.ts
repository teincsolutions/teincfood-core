/**
 * SQLite connection for the offline-first command outbox and event journal.
 * Delegates to injected SqliteDriver (see src/adapters/sqlite.ts).
 */

import { syncLogger } from "../utils/sync-logger";
import { MIGRATIONS } from "./migrations";
import { getSqliteDriver, hasSqliteDriver, type SQLiteDatabase } from "../adapters/sqlite";

const DB_NAME = "teincfood_sync.db";

let dbInstance: SQLiteDatabase | null = null;
let initPromise: Promise<SQLiteDatabase> | null = null;

export async function openSyncDatabase(): Promise<SQLiteDatabase> {
  if (dbInstance) return dbInstance;
  if (initPromise) return initPromise;

  if (!hasSqliteDriver()) {
    throw new Error(
      "SQLite driver not injected. Call setSqliteDriver(driver) before openSyncDatabase().",
    );
  }

  const driver = getSqliteDriver();

  initPromise = (async () => {
    await runMigrations(driver);
    dbInstance = driver;
    syncLogger.info("SQLite", "Database opened and migrated", {
      name: DB_NAME,
    });
    return driver;
  })();

  initPromise = initPromise.catch((error) => {
    initPromise = null;
    syncLogger.error("SQLite", "Failed to open sync database", {
      error: String(error),
    });
    throw error;
  });

  return initPromise;
}

export function getSyncDatabase(): SQLiteDatabase {
  if (!dbInstance) {
    // If driver injected but not yet opened, return driver directly to avoid "not initialized"
    // during early replay (cold start). Migration will run on openSyncDatabase.
    if (hasSqliteDriver()) {
      return getSqliteDriver();
    }
    throw new Error("Sync database not initialized. Call openSyncDatabase() first.");
  }
  return dbInstance;
}

async function runMigrations(db: SQLiteDatabase): Promise<void> {
  const doMigrate = async (): Promise<void> => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    for (const migration of MIGRATIONS) {
      const row = await db.getFirstAsync<{ version: number }>(
        "SELECT version FROM migrations WHERE version = ?;",
        migration.version,
      );
      if (row) continue;

      await migration.up(db);
      await db.runAsync(
        "INSERT INTO migrations (version, applied_at) VALUES (?, ?);",
        migration.version,
        new Date().toISOString(),
      );
      syncLogger.info("SQLite", "Applied migration", {
        version: migration.version,
      });
    }
  };

  if (db.withTransactionAsync) {
    await db.withTransactionAsync(doMigrate);
  } else {
    await doMigrate();
  }
}

export async function closeSyncDatabase(): Promise<void> {
  if (dbInstance) {
    if (dbInstance.closeAsync) await dbInstance.closeAsync();
    dbInstance = null;
    initPromise = null;
    syncLogger.info("SQLite", "Database closed");
  }
}
