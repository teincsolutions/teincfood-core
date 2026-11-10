/**
 * SQLite driver adapter — decouples core from expo-sqlite.
 * Host apps inject a concrete driver via setSqliteDriver().
 */

export interface SQLiteRunResult {
  lastInsertRowId: number;
  changes: number;
}

export interface SqliteDriver {
  execAsync(sql: string, ...args: unknown[]): Promise<void>;
  runAsync(sql: string, ...args: unknown[]): Promise<SQLiteRunResult>;
  getFirstAsync<T>(sql: string, ...args: unknown[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...args: unknown[]): Promise<T[]>;
  withTransactionAsync?(fn: () => Promise<void>): Promise<void>;
  closeAsync?(): Promise<void>;
  /**
   * Optional hook for host drivers that open one database file per account.
   * Core calls this before opening the connection; drivers should close their
   * current handle and switch to the file for `accountId`.
   */
  setAccountScope?(accountId: string | null): Promise<void> | void;
}

export type SQLiteDatabase = SqliteDriver;

let driver: SqliteDriver | null = null;

export function setSqliteDriver(d: SqliteDriver): void {
  driver = d;
}

export function getSqliteDriver(): SqliteDriver {
  if (!driver) {
    throw new Error(
      "SQLite driver not injected. Call setSqliteDriver(driver) before openSyncDatabase(). " +
        "Provide an object implementing SqliteDriver (see src/adapters/sqlite.ts).",
    );
  }
  return driver;
}

export function hasSqliteDriver(): boolean {
  return driver !== null;
}
