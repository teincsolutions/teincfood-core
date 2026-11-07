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
    record_tombstones: [],
  };
  let autoId = { commands: 1, events: 1, migrations: 1, sync_jobs: 1 };

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

      // record_tombstones upsert
      if (s.includes("INSERT INTO record_tombstones")) {
        const [business_id, collection, entity_id, deleted_at, device_id] = args as any[];
        const existing = tables.record_tombstones.find(
          (r) =>
            r.business_id === business_id &&
            r.collection === collection &&
            r.entity_id === entity_id,
        );
        if (existing) {
          if (String(deleted_at) > String(existing.deleted_at)) {
            existing.deleted_at = deleted_at;
            existing.device_id = device_id;
          }
        } else {
          tables.record_tombstones.push({ business_id, collection, entity_id, deleted_at, device_id });
        }
        return { lastInsertRowId: 1, changes: 1 };
      }
      if (s.includes("DELETE FROM record_tombstones WHERE business_id = ? AND collection = ? AND entity_id = ?")) {
        const [business_id, collection, entity_id] = args as string[];
        tables.record_tombstones = tables.record_tombstones.filter(
          (r) =>
            !(
              r.business_id === business_id &&
              r.collection === collection &&
              r.entity_id === entity_id
            ),
        );
        return { lastInsertRowId: 0, changes: 1 };
      }
      if (s.includes("DELETE FROM record_tombstones")) {
        tables.record_tombstones = [];
        return { lastInsertRowId: 0, changes: 1 };
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

      // crash recovery: in_flight -> pending on open
      if (s.includes("UPDATE commands SET status = 'pending'") && s.includes("WHERE status = 'in_flight'")) {
        let changes = 0;
        for (const row of tables.commands) {
          if (row.status === "in_flight") { row.status = "pending"; row.error = null; changes += 1; }
        }
        return { lastInsertRowId: 0, changes };
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
        const [id, business_id, order_number, callout_number, status, order_type, is_pos, items, subtotal_minor, total_minor, tax_minor, tax_lines, payment, paid_at, customer_name, customer_phone, pos_payment_method, payment_mode, delivery_id, business, user, inserted_at, updated_at, hlc] = args as any[];
        const existing = tables.orders.find((r) => r.id === id);
        // LWW check via hlc (if existing and incoming older, skip) — only for
        // the local/LAN write path. The server write path (`upsertServerOrder`)
        // has no hlc guard: the server copy always wins.
        const lwwGuarded = s.includes("excluded.hlc >= orders.hlc");
        if (existing) {
          if (lwwGuarded && hlc && existing.hlc && hlc < existing.hlc) return { lastInsertRowId: 0, changes: 0 };
          Object.assign(existing, { business_id, order_number, callout_number, status, order_type, is_pos, items, subtotal_minor, total_minor, tax_minor, tax_lines, payment, paid_at: paid_at ?? existing.paid_at ?? null, customer_name, customer_phone, pos_payment_method, payment_mode, delivery_id, business, user, inserted_at, updated_at, hlc });
          return { lastInsertRowId: 0, changes: 1 };
        }
        tables.orders.push({ id, business_id, order_number, callout_number, status, order_type, is_pos, items, subtotal_minor, total_minor, tax_minor, tax_lines, payment, paid_at: paid_at ?? null, customer_name, customer_phone, pos_payment_method, payment_mode, delivery_id, business, user, inserted_at, updated_at, hlc, deleted_at: null });
        return { lastInsertRowId: 1, changes: 1 };
      }

      // sync_jobs insert
      if (s.includes("INSERT OR IGNORE INTO sync_jobs")) {
        const [id, business_id, command_type, entity_id, payload, created_at, updated_at] = args as any[];
        if (tables.sync_jobs.find((r) => r.id === id)) return { lastInsertRowId: 0, changes: 0 };
        tables.sync_jobs.push({ rowid: autoId.sync_jobs++, id, business_id, command_type, entity_id, payload, status: "pending", attempts: 0, created_at, updated_at });
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
        const [payment, paid_at, hlc, business_id, id1, id2] = args as any[];
        const row = tables.orders.find((r) => r.business_id === business_id && (r.id === id1 || r.order_number === id2));
        if (row) { row.payment = payment; row.paid_at = row.paid_at ?? paid_at ?? null; row.hlc = hlc; }
        return { lastInsertRowId: 0, changes: 1 };
      }
      if (s.includes("UPDATE orders SET order_number=")) {
        const [order_number, hlc, business_id, id] = args as any[];
        const row = tables.orders.find((r) => r.business_id === business_id && r.id === id);
        if (row) { row.order_number = order_number; row.hlc = hlc; }
        return { lastInsertRowId: 0, changes: 1 };
      }
      if (s.includes("UPDATE orders SET sync_failed_at = ?")) {
        const [sync_failed_at, sync_error, business_id, id1, id2] = args as any[];
        const row = tables.orders.find((r) => r.business_id === business_id && (r.id === id1 || r.order_number === id2));
        if (row) { (row as any).sync_failed_at = sync_failed_at; (row as any).sync_error = sync_error; }
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

      // orders business lookup by id/number (payment event with no business_id)
      if (s.includes("SELECT business_id FROM orders WHERE id = ? OR order_number = ?")) {
        const [id1, id2] = args as string[];
        const row = tables.orders.find((r) => r.id === id1 || r.order_number === id2);
        return (row ? { business_id: row.business_id } as unknown as T : null);
      }

      // orders hlc probe (absorb-if-applied touch detection)
      if (s.includes("SELECT hlc FROM orders WHERE business_id = ? AND id = ?")) {
        const [business_id, id] = args as string[];
        const row = tables.orders.find((r) => r.business_id === business_id && r.id === id);
        return (row ? { hlc: row.hlc } as unknown as T : null);
      }

      // sync_jobs by primary key
      if (s.includes("SELECT * FROM sync_jobs WHERE id = ?")) {
        const [id] = args as string[];
        const row = tables.sync_jobs.find((r) => r.id === id);
        return (row as unknown as T) ?? null;
      }

      // sync_jobs pending single
      if (s.includes("SELECT * FROM sync_jobs WHERE business_id = ? AND entity_id = ? AND status='pending'")) {
        const [business_id, entity_id] = args as string[];
        const row = tables.sync_jobs.find((r) => r.business_id === business_id && r.entity_id === entity_id && r.status === "pending");
        return (row as unknown as T) ?? null;
      }

      // sync_jobs duplicate-command probe (transition coalescing)
      if (s.includes("SELECT id FROM sync_jobs WHERE business_id = ? AND entity_id = ? AND command_type = ?")) {
        const [business_id, entity_id, command_type] = args as string[];
        const row = tables.sync_jobs.find(
          (r) =>
            r.business_id === business_id &&
            r.entity_id === entity_id &&
            r.command_type === command_type &&
            r.status === "pending",
        );
        return (row as unknown as T) ?? null;
      }

      // generic orders exists check for migrations backfill: SELECT * FROM orders WHERE business_id=? (not needed)

      return null;
    },

    async getAllAsync<T>(sql: string, ...args: unknown[]): Promise<T[]> {
      const s = sql.replace(/\s+/g, " ").trim();

      if (s.includes("SELECT entity_id, deleted_at FROM record_tombstones WHERE business_id = ? AND collection = ?")) {
        const [business_id, collection] = args as string[];
        return tables.record_tombstones
          .filter((r) => r.business_id === business_id && r.collection === collection)
          .map((r) => ({ entity_id: r.entity_id, deleted_at: r.deleted_at } as unknown as T));
      }

      if (s.includes("SELECT entity_id FROM record_tombstones WHERE business_id = ? AND entity_id = ?")) {
        const [business_id, entity_id] = args as string[];
        return tables.record_tombstones
          .filter((r) => r.business_id === business_id && r.entity_id === entity_id)
          .map((r) => ({ entity_id: r.entity_id } as unknown as T));
      }

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

      if (
        s.includes("SELECT command_type, status") &&
        s.includes("FROM commands") &&
        s.includes("entity_id IN")
      ) {
        const [business_id, ...entityIds] = args as string[];
        return tables.commands
          .filter(
            (r) =>
              r.business_id === business_id &&
              entityIds.includes(r.entity_id) &&
              ["menu:create_item", "menu:update_item", "menu:delete_item"].includes(
                r.command_type,
              ) &&
              ["pending", "in_flight", "failed"].includes(r.status),
          )
          .map(
            (r) =>
              ({ command_type: r.command_type, status: r.status }) as unknown as T,
          );
      }

      if (
        s.includes("SELECT command_type, entity_id, payload FROM commands") &&
        s.includes("WHERE business_id = ?")
      ) {
        const [business_id, createType, updateType, deleteType] = args as string[];
        const wanted = new Set([createType, updateType, deleteType]);
        return tables.commands
          .filter(
            (r) =>
              r.business_id === business_id &&
              ["pending", "in_flight"].includes(r.status) &&
              wanted.has(r.command_type),
          )
          .sort((a, b) =>
            a.created_at === b.created_at ? a.id - b.id : a.created_at < b.created_at ? -1 : 1,
          )
          .map(
            (r) =>
              ({
                command_type: r.command_type,
                entity_id: r.entity_id,
                payload: r.payload,
              }) as unknown as T,
          );
      }

      if (s.includes("SELECT * FROM commands") && s.includes("WHERE status IN")) {
        const limit = args[args.length - 1] as number;
        // Mirror production: `failed` is terminal and only returned when the
        // caller opts in (includeFailed -> SQL contains 'failed').
        const includeFailed = s.includes("'failed'");
        let rows = tables.commands
          .filter((r) => r.status === "pending" || (includeFailed && r.status === "failed"))
          .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
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

      // orders list with filters (business_id + status/order_type/is_paid/q/date)
      if (s.includes("SELECT * FROM orders WHERE")) {
        const business_id = args[0] as string;
        let rows = tables.orders.filter((r) => r.business_id === business_id);
        // Consume filter args in the exact clause order produced by listOrders.
        let i = 1;
        if (s.includes("status IN")) {
          const n = (s.match(/status IN \([^)]*\)/)![0].match(/\?/g) || []).length;
          const statuses = (args as string[]).slice(i, i + n);
          i += n;
          if (statuses.length) rows = rows.filter((r) => statuses.includes(r.status));
        }
        if (s.includes("is_pos = ?")) {
          const v = Number(args[i++]) === 1;
          rows = rows.filter((r) => !!r.is_pos === v);
        }
        if (s.includes("order_type = ?")) {
          const t = args[i++];
          rows = rows.filter((r) => r.order_type === t);
        }
        if (s.includes("json_extract(payment, '$.is_paid') = 1")) {
          rows = rows.filter((r) => {
            try { return JSON.parse(r.payment ?? "{}").is_paid === true || r.paid_at != null; } catch { return r.paid_at != null; }
          });
        } else if (s.includes("json_extract(payment, '$.is_paid'), 0) = 0")) {
          rows = rows.filter((r) => {
            try { return JSON.parse(r.payment ?? "{}").is_paid !== true && r.paid_at == null; } catch { return r.paid_at == null; }
          });
        }
        if (s.includes("order_number LIKE ?")) {
          const term = String(args[i]).replace(/%/g, "").toLowerCase();
          i += 3;
          rows = rows.filter((r) =>
            String(r.order_number ?? "").toLowerCase().includes(term) ||
            String(r.customer_name ?? "").toLowerCase().includes(term) ||
            String(r.customer_phone ?? "").toLowerCase().includes(term),
          );
        }
        if (s.includes("inserted_at >= ?")) {
          const from = String(args[i++]);
          rows = rows.filter((r) => String(r.inserted_at) >= from);
        }
        if (s.includes("inserted_at < ?")) {
          const to = String(args[i++]);
          rows = rows.filter((r) => String(r.inserted_at) < to);
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
        let rows = tables.sync_jobs.filter((r) => r.business_id === business_id && r.status === "pending").sort((a,b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.rowid - b.rowid)).map((r) => ({ entity_id: r.entity_id }));
        rows = rows.slice(0, lim);
        return rows as unknown as T[];
      }

      // sync_jobs command list for a single entity (pending intent)
      if (s.includes("FROM sync_jobs WHERE business_id = ? AND entity_id = ?")) {
        const [business_id, entity_id] = args as string[];
        const rows = tables.sync_jobs
          .filter((r) => r.business_id === business_id && r.entity_id === entity_id && r.status === "pending")
          .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.rowid - b.rowid))
          .map((r) => ({ command_type: r.command_type, payload: r.payload }));
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
