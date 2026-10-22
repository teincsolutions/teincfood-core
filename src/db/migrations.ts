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
  {
    version: 5,
    up: async (db) => {
      // Real orders table — primary DB like backend Orders, device-partitioned by UUID + DD-RRR-CCC
      await db.execAsync(`
          CREATE TABLE IF NOT EXISTS orders (
            id TEXT PRIMARY KEY,
            business_id TEXT NOT NULL,
            order_number TEXT NOT NULL,
            callout_number INTEGER,
            status TEXT NOT NULL,
            order_type TEXT,
            is_pos INTEGER NOT NULL DEFAULT 0,
            items TEXT NOT NULL,
            subtotal_minor INTEGER NOT NULL DEFAULT 0,
            total_minor INTEGER NOT NULL DEFAULT 0,
            tax_minor INTEGER NOT NULL DEFAULT 0,
            tax_lines TEXT,
            payment TEXT,
            customer_name TEXT,
            customer_phone TEXT,
            pos_payment_method TEXT,
            delivery_id TEXT,
            business TEXT,
            user TEXT,
            inserted_at TEXT NOT NULL,
            hlc TEXT,
            deleted_at TEXT
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_order_number_business ON orders(business_id, order_number);
          CREATE INDEX IF NOT EXISTS idx_orders_business_status ON orders(business_id, status);
          CREATE INDEX IF NOT EXISTS idx_orders_business_ispos ON orders(business_id, is_pos);
          CREATE INDEX IF NOT EXISTS idx_orders_inserted ON orders(business_id, inserted_at DESC);
          CREATE INDEX IF NOT EXISTS idx_orders_hlc ON orders(hlc);
        `);
      // Backfill from existing entity_snapshots type='order' if any (best-effort, ignore failures on fresh DB)
      try {
        await db.execAsync(`
          INSERT OR IGNORE INTO orders (id, business_id, order_number, callout_number, status, order_type, is_pos, items, subtotal_minor, total_minor, tax_minor, tax_lines, payment, customer_name, customer_phone, pos_payment_method, delivery_id, business, user, inserted_at, hlc)
          SELECT
            json_extract(payload, '$.id') as id,
            json_extract(payload, '$.business_id') as business_id,
            json_extract(payload, '$.order_number') as order_number,
            json_extract(payload, '$.callout_number') as callout_number,
            json_extract(payload, '$.status') as status,
            json_extract(payload, '$.order_type') as order_type,
            CASE WHEN json_extract(payload, '$.is_pos') THEN 1 ELSE 0 END as is_pos,
            json_extract(payload, '$.items') as items,
            json_extract(payload, '$.subtotal_minor') as subtotal_minor,
            json_extract(payload, '$.total_minor') as total_minor,
            json_extract(payload, '$.tax_minor') as tax_minor,
            json_extract(payload, '$.tax_lines') as tax_lines,
            json_extract(payload, '$.payment') as payment,
            json_extract(payload, '$.customer_name') as customer_name,
            json_extract(payload, '$.customer_phone') as customer_phone,
            json_extract(payload, '$.pos_payment_method') as pos_payment_method,
            json_extract(payload, '$.delivery_id') as delivery_id,
            json_extract(payload, '$.business') as business,
            json_extract(payload, '$.user') as user,
            json_extract(payload, '$.inserted_at') as inserted_at,
            json_extract(payload, '$.hlc') as hlc
          FROM entity_snapshots WHERE entity_type='order' AND json_extract(payload, '$.id') IS NOT NULL;
        `);
      } catch {}
      // Sync outbox for background backend sync — secondary, not UI-blocking
      await db.execAsync(`
          CREATE TABLE IF NOT EXISTS sync_jobs (
            id TEXT PRIMARY KEY,
            business_id TEXT NOT NULL,
            command_type TEXT NOT NULL,
            entity_id TEXT,
            payload TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_sync_jobs_business ON sync_jobs(business_id, status);
        `);
    },
  },
  {
    version: 6,
    up: async (db) => {
      // v5 backfilled only entity_type='order' which never exists — real data is
      // entity_type='seller_orders' with {data: SellerOrder[]}. Backfill those via json_each.
      // idempotent INSERT OR IGNORE; also handles legacy 'order' type with COALESCE timestamps.
      try {
        await db.execAsync(`
          INSERT OR IGNORE INTO orders (id, business_id, order_number, callout_number, status, order_type, is_pos, items, subtotal_minor, total_minor, tax_minor, tax_lines, payment, customer_name, customer_phone, pos_payment_method, delivery_id, business, user, inserted_at, hlc)
          SELECT
            json_extract(value, '$.id') as id,
            COALESCE(json_extract(value, '$.business_id'), json_extract(value, '$.business.id'), '') as business_id,
            json_extract(value, '$.order_number') as order_number,
            json_extract(value, '$.callout_number') as callout_number,
            json_extract(value, '$.status') as status,
            json_extract(value, '$.order_type') as order_type,
            CASE WHEN json_extract(value, '$.is_pos') THEN 1 ELSE 0 END as is_pos,
            COALESCE(json_extract(value, '$.items'), '[]') as items,
            COALESCE(json_extract(value, '$.subtotal_minor'), 0) as subtotal_minor,
            COALESCE(json_extract(value, '$.total_minor'), 0) as total_minor,
            COALESCE(json_extract(value, '$.tax_minor'), 0) as tax_minor,
            json_extract(value, '$.tax_lines') as tax_lines,
            json_extract(value, '$.payment') as payment,
            json_extract(value, '$.customer_name') as customer_name,
            json_extract(value, '$.customer_phone') as customer_phone,
            json_extract(value, '$.pos_payment_method') as pos_payment_method,
            json_extract(value, '$.delivery_id') as delivery_id,
            json_extract(value, '$.business') as business,
            json_extract(value, '$.user') as user,
            COALESCE(json_extract(value, '$.inserted_at'), json_extract(value, '$.created_at'), last_event_timestamp, datetime('now')) as inserted_at,
            COALESCE(json_extract(value, '$.hlc'), last_event_timestamp, datetime('now')) as hlc
          FROM entity_snapshots, json_each(json_extract(payload, '$.data'))
          WHERE entity_type='seller_orders' AND json_extract(value, '$.id') IS NOT NULL AND json_extract(value, '$.order_number') IS NOT NULL;
        `);
      } catch {}
      try {
        await db.execAsync(`
          INSERT OR IGNORE INTO orders (id, business_id, order_number, callout_number, status, order_type, is_pos, items, subtotal_minor, total_minor, tax_minor, tax_lines, payment, customer_name, customer_phone, pos_payment_method, delivery_id, business, user, inserted_at, hlc)
          SELECT
            json_extract(payload, '$.id') as id,
            COALESCE(json_extract(payload, '$.business_id'), '') as business_id,
            json_extract(payload, '$.order_number') as order_number,
            json_extract(payload, '$.callout_number') as callout_number,
            json_extract(payload, '$.status') as status,
            json_extract(payload, '$.order_type') as order_type,
            CASE WHEN json_extract(payload, '$.is_pos') THEN 1 ELSE 0 END as is_pos,
            COALESCE(json_extract(payload, '$.items'), '[]') as items,
            COALESCE(json_extract(payload, '$.subtotal_minor'), 0) as subtotal_minor,
            COALESCE(json_extract(payload, '$.total_minor'), 0) as total_minor,
            COALESCE(json_extract(payload, '$.tax_minor'), 0) as tax_minor,
            json_extract(payload, '$.tax_lines') as tax_lines,
            json_extract(payload, '$.payment') as payment,
            json_extract(payload, '$.customer_name') as customer_name,
            json_extract(payload, '$.customer_phone') as customer_phone,
            json_extract(payload, '$.pos_payment_method') as pos_payment_method,
            json_extract(payload, '$.delivery_id') as delivery_id,
            json_extract(payload, '$.business') as business,
            json_extract(payload, '$.user') as user,
            COALESCE(json_extract(payload, '$.inserted_at'), last_event_timestamp, datetime('now')) as inserted_at,
            COALESCE(json_extract(payload, '$.hlc'), last_event_timestamp, datetime('now')) as hlc
          FROM entity_snapshots WHERE entity_type='order' AND json_extract(payload, '$.id') IS NOT NULL;
        `);
      } catch {}
    },
  },
  {
    version: 7,
    up: async (db) => {
      // Fix [object Object] order_number bug from 0.7.13 domain/service toString() on object
      try { await db.execAsync(`DELETE FROM orders WHERE order_number = '[object Object]';`); } catch {}
      try { await db.execAsync(`DELETE FROM sync_jobs WHERE payload LIKE '%[object Object]%';`); } catch {}
      try { await db.execAsync(`DELETE FROM entity_snapshots WHERE payload LIKE '%[object Object]%';`); } catch {}
    },
  },
  {
    version: 8,
    up: async (db) => {
      // Full drop legacy — new DB, no fallback (confirmed). Keep only orders, sync_jobs, reference_data, migrations.
      // Drops commands, events, entity_snapshots (replaced by orders primary).
      try { await db.execAsync(`DROP TABLE IF EXISTS commands;`); } catch {}
      try { await db.execAsync(`DROP TABLE IF EXISTS events;`); } catch {}
      // entity_snapshots kept for reference_data fallback? No — new DB no old stuff, drop all snapshots
      try { await db.execAsync(`DROP TABLE IF EXISTS entity_snapshots;`); } catch {}
      // Recreate minimal empty entity_snapshots if later code expects it (reference fallback disabled for orders)
      try {
        await db.execAsync(`
          CREATE TABLE IF NOT EXISTS entity_snapshots (
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            business_id TEXT,
            last_event_id TEXT NOT NULL,
            last_event_timestamp TEXT NOT NULL,
            payload TEXT NOT NULL,
            PRIMARY KEY (entity_type, entity_id)
          );
          CREATE INDEX IF NOT EXISTS idx_snapshots_entity_id ON entity_snapshots(entity_id);
          CREATE INDEX IF NOT EXISTS idx_snapshots_business ON entity_snapshots(business_id, entity_type);
        `);
      } catch {}
      // Clean any stale TFL remnants that survived
      try { await db.execAsync(`DELETE FROM sync_jobs WHERE payload LIKE '%TFL-%';`); } catch {}
    },
  },
  {
    version: 9,
    up: async (db) => {
      // v8 dropped commands/events as "legacy" while the engine outbox
      // (commandQueueService.enqueue) and the event journal (insertEvent,
      // hydrate, replay) still depend on them. On any DB that ran v8, every
      // queue/journal write throws "no such table", breaking offline queue
      // on all transports. Recreate exactly (IF NOT EXISTS: healthy DBs no-op).
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
    },
  },
  {
    version: 10,
    up: async (db) => {
      await db.execAsync(`
          ALTER TABLE orders ADD COLUMN updated_at TEXT;
        `);
    },
  },
  {
    version: 11,
    up: async (db) => {
      // Terminal sync failure marker: set when a queued order:create or a
      // transition dead-letters (e.g. the parent order was never created, or a
      // transition 404s because the order does not exist server-side). The row
      // is retained for audit instead of being silently dropped.
      await db.execAsync(`
          ALTER TABLE orders ADD COLUMN sync_failed_at TEXT;
        `);
      await db.execAsync(`
          ALTER TABLE orders ADD COLUMN sync_error TEXT;
        `);
    },
  },
  {
    version: 12,
    up: async (db) => {
      // Payment timestamp at the top level of the order.
      //
      // The server returns `paid_at` on the order and (for cash sales taken at
      // the till) no payment transaction at all. Keeping the timestamp only
      // inside the `payment` JSON blob meant every pull overwrote a locally
      // paid cash order with the server's `{is_paid:false, paid_at:null}`,
      // so the row read back as UNPAID. One column, backfilled from the blob,
      // is the single local source of truth.
      await db.execAsync(`
          ALTER TABLE orders ADD COLUMN paid_at TEXT;
        `);
      try {
        await db.execAsync(`
            UPDATE orders
               SET paid_at = json_extract(payment, '$.paid_at')
             WHERE paid_at IS NULL
               AND json_extract(payment, '$.paid_at') IS NOT NULL;
          `);
      } catch {}
    },
  },
];
