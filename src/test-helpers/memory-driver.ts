/**
 * In-memory SQLite driver for standalone integration tests (0.7.0).
 * Covers migrations, reference_data, entity_snapshots, commands, events.
 * No SQL parsing — string-contains dispatch, JSON payloads.
 */
import type { SqliteDriver, SQLiteRunResult } from "../adapters/sqlite";

type Row = Record<string, any>;

export function createMemoryDriver(): SqliteDriver {
  const tables: Record<string, Row[]> = {
    migrations: [],
    reference_data: [],
    entity_snapshots: [],
    commands: [],
    events: [],
  };
  let autoId = { commands: 1, events: 1, migrations: 1 };

  const driver: SqliteDriver = {
    async execAsync(_sql: string) {
      // No-op: CREATE TABLE / INDEX / ALTER all just ensure table array exists.
      // For ALTER ADD COLUMN we don't need to do anything — rows are schemaless.
      return;
    },

    async runAsync(sql: string, ...args: unknown[]): Promise<SQLiteRunResult> {
      const s = sql.replace(/\s+/g, " ").trim();

      // migrations insert
      if (s.includes("INSERT INTO migrations")) {
        const version = args[0] as number;
        tables.migrations.push({ version, applied_at: args[1] });
        return { lastInsertRowId: autoId.migrations++, changes: 1 };
      }

      // reference_data insert
      if (s.includes("INSERT INTO reference_data")) {
        const [business_id, key, version, payload, downloaded_at, last_event_id, last_hlc] = args as any[];
        const idx = tables.reference_data.findIndex((r) => r.business_id === business_id && r.key === key);
        const row = { business_id, key, version, payload, downloaded_at, last_event_id, last_hlc };
        if (idx >= 0) tables.reference_data[idx] = row;
        else tables.reference_data.push(row);
        return { lastInsertRowId: 1, changes: 1 };
      }

      // reference_data delete
      if (s.includes("DELETE FROM reference_data WHERE business_id = ? AND key =")) {
        const [business_id, key] = args as string[];
        tables.reference_data = tables.reference_data.filter((r) => !(r.business_id === business_id && r.key === key));
        return { lastInsertRowId: 0, changes: 1 };
      }
      if (s.includes("DELETE FROM reference_data WHERE business_id = ?")) {
        const [business_id] = args as string[];
        tables.reference_data = tables.reference_data.filter((r) => r.business_id !== business_id);
        return { lastInsertRowId: 0, changes: 1 };
      }

      // entity_snapshots insert
      if (s.includes("INSERT INTO entity_snapshots")) {
        const [entity_type, entity_id, business_id, last_event_id, last_event_timestamp, payload] = args as any[];
        const idx = tables.entity_snapshots.findIndex((r) => r.entity_type === entity_type && r.entity_id === entity_id);
        const row = { entity_type, entity_id, business_id, last_event_id, last_event_timestamp, payload };
        if (idx >= 0) tables.entity_snapshots[idx] = row;
        else tables.entity_snapshots.push(row);
        return { lastInsertRowId: 1, changes: 1 };
      }

      // entity_snapshots delete
      if (s.includes("DELETE FROM entity_snapshots WHERE entity_type = ? AND entity_id =")) {
        const [entity_type, entity_id] = args as string[];
        tables.entity_snapshots = tables.entity_snapshots.filter((r) => !(r.entity_type === entity_type && r.entity_id === entity_id));
        return { lastInsertRowId: 0, changes: 1 };
      }
      if (s.includes("DELETE FROM entity_snapshots WHERE entity_type = ? AND last_event_timestamp <")) {
        const [entity_type, cutoff] = args as string[];
        tables.entity_snapshots = tables.entity_snapshots.filter((r) => !(r.entity_type === entity_type && r.last_event_timestamp < cutoff));
        return { lastInsertRowId: 0, changes: 1 };
      }

      // commands insert
      if (s.includes("INSERT INTO commands")) {
        const [command_id, command_type, command_version, business_id, entity_id, user_id, device_id, payload, status] = args as any[];
        const existing = tables.commands.find((r) => r.command_id === command_id);
        const row = {
          id: existing ? existing.id : autoId.commands++,
          command_id,
          command_type,
          command_version,
          business_id,
          entity_id,
          user_id,
          device_id,
          payload,
          status,
          error: null,
          retry_count: 0,
          last_attempted_at: null,
          created_at: args[11] as string,
          updated_at: args[12] as string,
          timestamp: new Date().toISOString(),
        };
        if (existing) Object.assign(existing, row);
        else tables.commands.push(row);
        return { lastInsertRowId: row.id, changes: 1 };
      }

      // commands update status
      if (s.includes("UPDATE commands SET status = ?")) {
        const [status, error, _now, _now2, command_id] = args as any[];
        // also handles variants with retry_count increment
        const row = tables.commands.find((r) => r.command_id === command_id);
        if (row) {
          row.status = status;
          row.error = error;
          if (s.includes("retry_count = retry_count + 1")) row.retry_count += 1;
        }
        return { lastInsertRowId: 0, changes: 1 };
      }
      if (s.includes("UPDATE commands SET status = 'in_flight'")) {
        const [now, _now2, command_id] = args as any[];
        const row = tables.commands.find((r) => r.command_id === command_id);
        if (row) { row.status = "in_flight"; row.last_attempted_at = now; }
        return { lastInsertRowId: 0, changes: 1 };
      }
      if (s.includes("DELETE FROM commands WHERE command_id")) {
        const [command_id] = args as string[];
        tables.commands = tables.commands.filter((r) => r.command_id !== command_id);
        return { lastInsertRowId: 0, changes: 1 };
      }
      if (s.includes("DELETE FROM commands WHERE status = 'completed'")) {
        const [cutoff] = args as string[];
        tables.commands = tables.commands.filter((r) => !(r.status === "completed" && r.updated_at < cutoff));
        return { lastInsertRowId: 0, changes: 1 };
      }
      if (s.includes("UPDATE commands SET payload")) {
        // handles both old (payload, command_id) and new (payload, error, updated_at, command_id)
        const payload = args[0] as string;
        const command_id = args[args.length - 1] as string;
        const row = tables.commands.find((r) => r.command_id === command_id);
        if (row) {
          row.payload = payload;
          if (args.length === 4) {
            row.error = args[1] as string;
            row.updated_at = args[2] as string;
          }
        }
        return { lastInsertRowId: 0, changes: 1 };
      }

      // events insert
      if (s.includes("INSERT INTO events")) {
        const [event_id, event_type, event_version, entity_id, user_id, device_id, payload, origin, synced_to_cloud, timestamp, persisted_at] = args as any[];
        if (tables.events.find((r) => r.event_id === event_id)) return { lastInsertRowId: 0, changes: 0 };
        const row = {
          id: autoId.events++,
          event_id,
          event_type,
          event_version,
          entity_id,
          user_id,
          device_id,
          payload,
          origin,
          synced_to_cloud,
          timestamp,
          persisted_at,
        };
        tables.events.push(row);
        return { lastInsertRowId: row.id, changes: 1 };
      }

      // events update synced
      if (s.includes("UPDATE events SET synced_to_cloud = 1 WHERE event_id IN")) {
        const ids = args as string[];
        for (const row of tables.events) if (ids.includes(row.event_id)) row.synced_to_cloud = 1;
        return { lastInsertRowId: 0, changes: ids.length };
      }

      return { lastInsertRowId: 0, changes: 0 };
    },

    async getFirstAsync<T>(sql: string, ...args: unknown[]): Promise<T | null> {
      const s = sql.replace(/\s+/g, " ").trim();

      if (s.includes("SELECT version FROM migrations WHERE version =")) {
        const version = args[0] as number;
        const row = tables.migrations.find((r) => r.version === version);
        return (row ? { version: row.version } as unknown as T : null);
      }

      if (s.includes("SELECT * FROM reference_data WHERE business_id = ? AND key =")) {
        const [business_id, key] = args as string[];
        const row = tables.reference_data.find((r) => r.business_id === business_id && r.key === key);
        return (row as unknown as T) ?? null;
      }

      if (s.includes("SELECT version FROM reference_data WHERE business_id = ? AND key =")) {
        const [business_id, key] = args as string[];
        const row = tables.reference_data.find((r) => r.business_id === business_id && r.key === key);
        return (row ? { version: row.version } as unknown as T : null);
      }

      if (s.includes("SELECT last_event_timestamp FROM entity_snapshots WHERE entity_type = ? AND entity_id =")) {
        const [entity_type, entity_id] = args as string[];
        const row = tables.entity_snapshots.find((r) => r.entity_type === entity_type && r.entity_id === entity_id);
        return (row ? { last_event_timestamp: row.last_event_timestamp } as unknown as T : null);
      }

      if (s.includes("SELECT * FROM entity_snapshots WHERE entity_type = ? AND entity_id = ? AND business_id =")) {
        const [entity_type, entity_id, business_id] = args as string[];
        const row = tables.entity_snapshots.find((r) => r.entity_type === entity_type && r.entity_id === entity_id && r.business_id === business_id);
        return (row as unknown as T) ?? null;
      }

      if (s.includes("SELECT * FROM entity_snapshots WHERE entity_type = ? AND entity_id =")) {
        const [entity_type, entity_id] = args as string[];
        const row = tables.entity_snapshots.find((r) => r.entity_type === entity_type && r.entity_id === entity_id);
        return (row as unknown as T) ?? null;
      }

      if (s.includes("SELECT * FROM commands WHERE id =")) {
        const id = args[0] as number;
        const row = tables.commands.find((r) => r.id === id);
        return (row as unknown as T) ?? null;
      }

      return null;
    },

    async getAllAsync<T>(sql: string, ...args: unknown[]): Promise<T[]> {
      const s = sql.replace(/\s+/g, " ").trim();

      if (s.includes("SELECT key FROM reference_data WHERE business_id = ? ORDER BY key")) {
        const [business_id] = args as string[];
        return tables.reference_data.filter((r) => r.business_id === business_id).map((r) => ({ key: r.key } as unknown as T));
      }

      if (s.includes("SELECT * FROM entity_snapshots WHERE entity_type = ? AND business_id = ? ORDER BY last_event_timestamp DESC")) {
        const [entity_type, business_id] = args as string[];
        const rows = tables.entity_snapshots.filter((r) => r.entity_type === entity_type && r.business_id === business_id).sort((a, b) => (a.last_event_timestamp < b.last_event_timestamp ? 1 : -1));
        return rows as unknown as T[];
      }

      if (s.includes("SELECT * FROM entity_snapshots WHERE entity_type = ? ORDER BY last_event_timestamp DESC")) {
        const [entity_type] = args as string[];
        const rows = tables.entity_snapshots.filter((r) => r.entity_type === entity_type).sort((a, b) => (a.last_event_timestamp < b.last_event_timestamp ? 1 : -1));
        return rows as unknown as T[];
      }

      if (s.includes("SELECT * FROM commands") && s.includes("WHERE status IN")) {
        const limit = args[args.length - 1] as number;
        let rows = tables.commands.filter((r) => r.status === "pending" || r.status === "failed").sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
        if (limit) rows = rows.slice(0, limit);
        return rows as unknown as T[];
      }

      if (s.includes("SELECT * FROM events") && s.includes("WHERE entity_id = ?")) {
        const [entity_id, limit] = args as any[];
        let rows = tables.events.filter((r) => r.entity_id === entity_id).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
        if (limit) rows = rows.slice(0, limit);
        return rows as unknown as T[];
      }

      if (s.includes("SELECT * FROM events") && s.includes("WHERE origin = ? AND synced_to_cloud = 0")) {
        const [origin, limit] = args as any[];
        let rows = tables.events.filter((r) => r.origin === origin && r.synced_to_cloud === 0).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
        if (limit && limit !== Number.MAX_SAFE_INTEGER) rows = rows.slice(0, limit);
        return rows as unknown as T[];
      }

      return [];
    },
  };

  // expose tables for inspection in tests
  (driver as any)._tables = tables;
  return driver;
}

export function resetMemoryDriver() {
  // helper for isolation — callers create new driver per test
}
