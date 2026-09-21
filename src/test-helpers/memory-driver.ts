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
    orders: [],
    sync_jobs: [],
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

      // commands update status (4- or 5-placeholder variants — always take the
      // LAST arg as command_id; older code assumed 5).
      if (s.includes("UPDATE commands SET status = ?")) {
        const argv = args as any[];
        const status = argv[0];
        const error = argv[1];
        const command_id = argv[argv.length - 1];
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

      // orders insert (primary DB)
      if (s.includes("INSERT INTO orders")) {
        const [id, business_id, order_number, callout_number, status, order_type, is_pos, items, subtotal_minor, total_minor, tax_minor, tax_lines, payment, customer_name, customer_phone, pos_payment_method, delivery_id, business, user, inserted_at, hlc] = args as any[];
        const existing = tables.orders.find((r) => r.id === id);
        // LWW check via hlc (if existing and incoming older, skip)
        if (existing) {
          if (hlc && existing.hlc && hlc < existing.hlc) return { lastInsertRowId: 0, changes: 0 };
          Object.assign(existing, { business_id, order_number, callout_number, status, order_type, is_pos, items, subtotal_minor, total_minor, tax_minor, tax_lines, payment, customer_name, customer_phone, pos_payment_method, delivery_id, business, user, inserted_at, hlc });
          return { lastInsertRowId: 0, changes: 1 };
        }
        tables.orders.push({ id, business_id, order_number, callout_number, status, order_type, is_pos, items, subtotal_minor, total_minor, tax_minor, tax_lines, payment, customer_name, customer_phone, pos_payment_method, delivery_id, business, user, inserted_at, hlc, deleted_at: null });
        return { lastInsertRowId: 1, changes: 1 };
      }

      // sync_jobs insert
      if (s.includes("INSERT OR IGNORE INTO sync_jobs")) {
        const [id, business_id, command_type, entity_id, payload, created_at, updated_at] = args as any[];
        if (tables.sync_jobs.find((r) => r.id === id)) return { lastInsertRowId: 0, changes: 0 };
        tables.sync_jobs.push({ id, business_id, command_type, entity_id, payload, status: "pending", attempts: 0, created_at, updated_at });
        return { lastInsertRowId: 1, changes: 1 };
      }

      // sync_jobs update status=completed
      if (s.includes("UPDATE sync_jobs SET status='completed'")) {
        const [updated_at, id] = args as any[];
        const row = tables.sync_jobs.find((r) => r.id === id);
        if (row) { row.status = "completed"; row.updated_at = updated_at; }
        return { lastInsertRowId: 0, changes: 1 };
      }
      // sync_jobs update status=failed with last_error (permanent + exhausted retries)
      if (s.includes("UPDATE sync_jobs SET status='failed'")) {
        const [last_error, updated_at, id] = args as any[];
        const row = tables.sync_jobs.find((r) => r.id === id);
        if (row) { row.status = "failed"; row.last_error = last_error; row.updated_at = updated_at; }
        return { lastInsertRowId: 0, changes: 1 };
      }
      if (s.includes("UPDATE sync_jobs SET payload=")) {
        const [payload, updated_at, id] = args as any[];
        const row = tables.sync_jobs.find((r) => r.id === id);
        if (row) { row.payload = payload; row.updated_at = updated_at; }
        return { lastInsertRowId: 0, changes: 1 };
      }
      if (s.includes("UPDATE sync_jobs SET attempts = attempts + 1")) {
        const [last_error, updated_at, id] = args as any[];
        const row = tables.sync_jobs.find((r) => r.id === id);
        if (row) { row.attempts = (row.attempts ?? 0) + 1; row.last_error = last_error; row.updated_at = updated_at; }
        return { lastInsertRowId: 0, changes: 1 };
      }

      // orders updates
      if (s.includes("UPDATE orders SET status = ?")) {
        const [status, hlc, business_id, id1, id2] = args as any[];
        const row = tables.orders.find((r) => r.business_id === business_id && (r.id === id1 || r.order_number === id2));
        if (row) { row.status = status; row.hlc = hlc; }
        return { lastInsertRowId: 0, changes: 1 };
      }
      if (s.includes("UPDATE orders SET payment = ?")) {
        const [payment, hlc, business_id, id1, id2] = args as any[];
        const row = tables.orders.find((r) => r.business_id === business_id && (r.id === id1 || r.order_number === id2));
        if (row) { row.payment = payment; row.hlc = hlc; }
        return { lastInsertRowId: 0, changes: 1 };
      }
      if (s.includes("UPDATE orders SET order_number=")) {
        const [order_number, hlc, business_id, id] = args as any[];
        const row = tables.orders.find((r) => r.business_id === business_id && r.id === id);
        if (row) { row.order_number = order_number; row.hlc = hlc; }
        return { lastInsertRowId: 0, changes: 1 };
      }

      // cleanup deletes for v7
      if (s.includes("DELETE FROM orders WHERE order_number = '[object Object]'")) {
        const before = tables.orders.length;
        tables.orders = tables.orders.filter((r) => r.order_number !== "[object Object]");
        return { lastInsertRowId: 0, changes: before - tables.orders.length };
      }
      if (s.includes("DELETE FROM sync_jobs WHERE payload LIKE")) {
        const before = tables.sync_jobs.length;
        tables.sync_jobs = tables.sync_jobs.filter((r) => !String(r.payload).includes("[object Object]"));
        return { lastInsertRowId: 0, changes: before - tables.sync_jobs.length };
      }
      if (s.includes("DELETE FROM entity_snapshots WHERE payload LIKE")) {
        const before = tables.entity_snapshots.length;
        tables.entity_snapshots = tables.entity_snapshots.filter((r) => !String(r.payload).includes("[object Object]"));
        return { lastInsertRowId: 0, changes: before - tables.entity_snapshots.length };
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

      // orders count
      if (s.includes("SELECT COUNT(*) as c FROM orders WHERE")) {
        const business_id = args[0] as string;
        const c = tables.orders.filter((r) => r.business_id === business_id).length;
        return { c } as unknown as T;
      }

      // orders get by id or order_number
      if (s.includes("SELECT * FROM orders WHERE business_id = ? AND (id = ? OR order_number = ?)")) {
        const [business_id, id1, id2] = args as string[];
        const row = tables.orders.find((r) => r.business_id === business_id && (r.id === id1 || r.order_number === id2));
        return (row as unknown as T) ?? null;
      }

      // orders hlc probe (absorb-if-applied touch detection)
      if (s.includes("SELECT hlc FROM orders WHERE business_id = ? AND id = ?")) {
        const [business_id, id] = args as string[];
        const row = tables.orders.find((r) => r.business_id === business_id && r.id === id);
        return (row ? { hlc: row.hlc } as unknown as T : null);
      }

      // sync_jobs pending single
      if (s.includes("SELECT * FROM sync_jobs WHERE business_id = ? AND entity_id = ? AND status='pending'")) {
        const [business_id, entity_id] = args as string[];
        const row = tables.sync_jobs.find((r) => r.business_id === business_id && r.entity_id === entity_id && r.status === "pending");
        return (row as unknown as T) ?? null;
      }

      // generic orders exists check for migrations backfill: SELECT * FROM orders WHERE business_id=? (not needed)

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

      // orders list with filters (simple business_id filter + pagination)
      if (s.includes("SELECT * FROM orders WHERE")) {
        const business_id = args[0] as string;
        // args includes where-clause params plus LIMIT and OFFSET at end
        // For test, just filter by business_id and apply basic status/q if present in sql string via args slicing?
        // Simpler: return all orders for that business, sorted by inserted_at desc, handle LIMIT/OFFSET manually
        let rows = tables.orders.filter((r) => r.business_id === business_id);
        // handle status filter if sql contains status IN
        if (s.includes("status IN")) {
          // find args that are status values (excluding business_id, limit, offset)
          // Our sql: SELECT * FROM orders WHERE business_id = ? AND status IN (?,?) ... LIMIT ? OFFSET ?
          // So statuses are args[1]..args[?]
          // Count statuses by parsing SQL placeholder count?
          // For test, just extract known statuses from args that look like status strings
          const possibleStatuses = ["pending","awaiting_payment","accepted","preparing","ready","waiting_pickup","on_the_way","arrived","delivered","cancelled","assigned","picked_up","en_route","failed"];
          const statusArgs = (args as string[]).filter((v) => possibleStatuses.includes(String(v)));
          if (statusArgs.length) rows = rows.filter((r) => statusArgs.includes(r.status));
        }
        rows = rows.sort((a,b) => (a.inserted_at < b.inserted_at ? 1 : -1));
        const limit = args[args.length - 2] as number;
        const offset = args[args.length - 1] as number;
        if (typeof limit === "number" && typeof offset === "number") {
          rows = rows.slice(offset, offset + limit);
        }
        return rows as unknown as T[];
      }

      // sync_jobs pending list (generic, handles LIMIT 1/20)
      if (s.includes("SELECT entity_id FROM sync_jobs") && s.includes("status='pending'")) {
        const [business_id] = args as string[];
        const m = s.match(/LIMIT\s+(\d+)/);
        const lim = m ? parseInt(m[1],10) : 20;
        let rows = tables.sync_jobs.filter((r) => r.business_id === business_id && r.status === "pending").sort((a,b) => (a.created_at < b.created_at ? -1 : 1)).map((r) => ({ entity_id: r.entity_id }));
        rows = rows.slice(0, lim);
        return rows as unknown as T[];
      }

      if (s.includes("SELECT * FROM sync_jobs WHERE") || s.includes("SELECT id, command_type, status, created_at FROM sync_jobs")) {
        const [business_id] = args as string[];
        const rows = tables.sync_jobs.filter((r) => r.business_id === business_id);
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
