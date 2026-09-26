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
    await recoverInFlightCommands(driver);
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

/**
 * Crash recovery: a process kill between `markCommandInFlight` and the
 * command's terminal update leaves rows stuck in `in_flight`. They are
 * invisible to the outbox query (which selects pending only), so the order
 * would silently never sync. Reset them to pending on open so the next replay
 * picks them up. Idempotent and safe: a fresh process owns all in-flight work.
 */
async function recoverInFlightCommands(db: SQLiteDatabase): Promise<void> {
  try {
    const result = await db.runAsync(
      "UPDATE commands SET status = 'pending', error = NULL, updated_at = ? WHERE status = 'in_flight';",
      new Date().toISOString(),
    );
    const changes = (result as { changes?: number } | undefined)?.changes ?? 0;
    if (changes > 0) {
      syncLogger.warn("SQLite", "Recovered in-flight commands after restart", {
        count: changes,
      });
    }
  } catch (error) {
    // Never block DB open on recovery — replay/backoff still works.
    syncLogger.error("SQLite", "in-flight recovery failed", {
      error: String(error),
    });
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
