/**
 * SQLite connection for the offline-first command outbox and event journal.
 * Delegates to injected SqliteDriver (see src/adapters/sqlite.ts).
 */

import { syncLogger } from "../utils/sync-logger";
import { MIGRATIONS } from "./migrations";
import { getSqliteDriver, hasSqliteDriver, type SQLiteDatabase } from "../adapters/sqlite";
import { getAccountScope } from "../session/account-scope";

const DB_NAME = "teincfood_sync.db";

let dbInstance: SQLiteDatabase | null = null;
let initPromise: Promise<SQLiteDatabase> | null = null;
/** Account whose database the current handle belongs to. */
let openedAccountId: string | null | undefined;

export async function openSyncDatabase(): Promise<SQLiteDatabase> {
  const accountId = getAccountScope();

  // A different account must never reuse the previous account's connection.
  if (dbInstance && openedAccountId !== accountId) {
    await closeSyncDatabase();
  }
  if (dbInstance) return dbInstance;
  if (initPromise) {
    // An open for a previous scope may still be running. Never hand its
    // handle to the new account; settle it, close it, then open the new file.
    await initPromise.catch(() => undefined);
    if (dbInstance && openedAccountId === accountId) return dbInstance;
    await closeSyncDatabase();
  }

  if (!hasSqliteDriver()) {
    throw new Error(
      "SQLite driver not injected. Call setSqliteDriver(driver) before openSyncDatabase().",
    );
  }

  const driver = getSqliteDriver();

  initPromise = (async () => {
    // Host drivers open a per-account file (e.g. teincfood_sync_<userId>.db).
    try {
      await driver.setAccountScope?.(accountId);
    } catch (error) {
      syncLogger.warn("SQLite", "Driver account-scope switch failed", {
        accountId,
        error: String(error),
      });
    }
    await runMigrations(driver);
    await recoverInFlightCommands(driver);
    dbInstance = driver;
    openedAccountId = accountId;
    syncLogger.info("SQLite", "Database opened and migrated", {
      name: accountId ? `${DB_NAME} (account ${accountId})` : DB_NAME,
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
  // If an open is in flight, let it settle so we close the handle it created
  // instead of leaking a connection to the previous account's file.
  if (initPromise && !dbInstance) {
    try {
      await initPromise;
    } catch {
      // Failed opens have nothing to close.
    }
  }
  if (dbInstance) {
    if (dbInstance.closeAsync) await dbInstance.closeAsync();
    dbInstance = null;
    initPromise = null;
    openedAccountId = undefined;
    syncLogger.info("SQLite", "Database closed");
  } else {
    initPromise = null;
    openedAccountId = undefined;
  }
}
