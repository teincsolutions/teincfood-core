/**
 * SQLite migrations for the offline-first command outbox and event journal.
 */

import type { SQLiteDatabase } from "../adapters/sqlite";

export interface Migration {
  version: number;
  up: (db: SQLiteDatabase) => Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: async (db) => {
      await db.execAsync(`
          CREATE TABLE IF NOT EXISTS commands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            command_id TEXT NOT NULL UNIQUE,
            command_type TEXT NOT NULL,
            command_version TEXT NOT NULL,
            business_id TEXT NOT NULL,
            entity_id TEXT,
            user_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            error TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            last_attempted_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_commands_status ON commands(status);
          CREATE INDEX IF NOT EXISTS idx_commands_business ON commands(business_id);
          CREATE INDEX IF NOT EXISTS idx_commands_entity ON commands(entity_id);
          CREATE INDEX IF NOT EXISTS idx_commands_created_at ON commands(created_at);
        `);

      await db.execAsync(`
          CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            event_type TEXT NOT NULL,
            event_version TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            origin TEXT NOT NULL,
            synced_to_cloud INTEGER NOT NULL DEFAULT 0,
            timestamp TEXT NOT NULL,
            persisted_at TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
          CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_id);
          CREATE INDEX IF NOT EXISTS idx_events_synced ON events(synced_to_cloud);
          CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
          CREATE INDEX IF NOT EXISTS idx_events_origin ON events(origin);
        `);

      await db.execAsync(`
          CREATE TABLE IF NOT EXISTS entity_snapshots (
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            last_event_id TEXT NOT NULL,
            last_event_timestamp TEXT NOT NULL,
            payload TEXT NOT NULL,
            PRIMARY KEY (entity_type, entity_id)
          );

          CREATE INDEX IF NOT EXISTS idx_snapshots_entity_id ON entity_snapshots(entity_id);
        `);

      await db.execAsync(`
          CREATE TABLE IF NOT EXISTS reference_data (
            key TEXT NOT NULL PRIMARY KEY,
            version TEXT NOT NULL,
            payload TEXT NOT NULL,
            downloaded_at TEXT NOT NULL
          );
        `);
    },
  },
  {
    version: 2,
    up: async (db) => {
      await db.execAsync(`
          ALTER TABLE entity_snapshots ADD COLUMN business_id TEXT;
          CREATE INDEX IF NOT EXISTS idx_snapshots_business ON entity_snapshots(business_id, entity_type);

          CREATE TABLE reference_data_new (
            business_id TEXT NOT NULL,
            key TEXT NOT NULL,
            version TEXT NOT NULL,
            payload TEXT NOT NULL,
            downloaded_at TEXT NOT NULL,
            PRIMARY KEY (business_id, key)
          );
        `);

      await db.execAsync(`
          INSERT INTO reference_data_new (business_id, key, version, payload, downloaded_at)
          SELECT '', key, version, payload, downloaded_at FROM reference_data;
        `);

      await db.execAsync(`
          DROP TABLE reference_data;
          ALTER TABLE reference_data_new RENAME TO reference_data;
          CREATE INDEX IF NOT EXISTS idx_reference_data_business ON reference_data(business_id);
        `);
    },
  },
  {
    version: 3,
    up: async (db) => {
      await db.execAsync(`
          ALTER TABLE reference_data ADD COLUMN last_event_id TEXT;
          ALTER TABLE reference_data ADD COLUMN last_hlc TEXT;
          CREATE INDEX IF NOT EXISTS idx_reference_data_hlc ON reference_data(last_hlc);
        `);
    },
  },
  {
    version: 4,
    up: async (db) => {
      // Clear stale completed outbox rows and legacy TFL- order numbers that
      // accumulated before 0.7.0's DD-RRR-CCC cutover. Pending/failed/in_flight
      // are kept so an in-flight replay is not lost; only completed + legacy
      // payloads are pruned. Also clears legacy optimistic events.
      await db.execAsync(`
          DELETE FROM commands WHERE status = 'completed';
        `);
      try {
        await db.execAsync(`
            DELETE FROM commands WHERE payload LIKE '%TFL-%';
          `);
      } catch {}
      try {
        await db.execAsync(`
            DELETE FROM events WHERE payload LIKE '%TFL-%';
          `);
      } catch {}
    },
  },
];
