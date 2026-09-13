/**
 * Low-level SQLite operations for the command outbox and event journal.
 */

import type { SQLiteDatabase, SQLiteRunResult } from "../adapters/sqlite";
import type { Command, DomainEvent, PersistedCommand } from "../sync/types";
import { syncLogger } from "../utils/sync-logger";

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────

export interface InsertCommandInput {
  command: Command;
  status?: PersistedCommand["status"];
}

export async function insertCommand(
  db: SQLiteDatabase,
  input: InsertCommandInput,
): Promise<PersistedCommand> {
  const { command, status = "pending" } = input;
  const now = new Date().toISOString();
  const payload = JSON.stringify(command.payload);

  const result = await db.runAsync(
    `
      INSERT INTO commands (
        command_id, command_type, command_version, business_id, entity_id,
        user_id, device_id, payload, status, retry_count, last_attempted_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(command_id) DO UPDATE SET
        status = excluded.status,
        payload = excluded.payload,
        updated_at = excluded.updated_at;
    `,
    command.command_id,
    command.command_type,
    command.command_version,
    command.business_id,
    command.entity_id ?? null,
    command.user_id,
    command.device_id,
    payload,
    status,
    0,
    null,
    now,
    now,
  );

  const row = await db.getFirstAsync<PersistedCommandRow>(
    "SELECT * FROM commands WHERE id = ?;",
    result.lastInsertRowId,
  );

  if (!row) {
    throw new Error(`Failed to insert command ${command.command_id}`);
  }

  syncLogger.command(command, "queued");
  return rowToPersistedCommand(row);
}

export async function getPendingCommands(
  db: SQLiteDatabase,
  limit = 100,
): Promise<PersistedCommand[]> {
  const rows = await db.getAllAsync<PersistedCommandRow>(
    `
      SELECT * FROM commands
      WHERE status IN ('pending', 'failed')
      ORDER BY created_at ASC
      LIMIT ?;
    `,
    limit,
  );
  return rows.map(rowToPersistedCommand);
}

export async function updateCommandStatus(
  db: SQLiteDatabase,
  commandId: string,
  status: PersistedCommand["status"],
  error?: string,
): Promise<void> {
  const now = new Date().toISOString();
  if (status === "failed") {
    await db.runAsync(
      `
        UPDATE commands
        SET status = ?, error = ?, retry_count = retry_count + 1,
            last_attempted_at = ?, updated_at = ?
        WHERE command_id = ?;
      `,
      status,
      error ?? null,
      now,
      now,
      commandId,
    );
  } else if (status === "completed") {
    await db.runAsync(
      "UPDATE commands SET status = ?, error = NULL, updated_at = ? WHERE command_id = ?;",
      status,
      now,
      commandId,
    );
  } else {
    await db.runAsync(
      "UPDATE commands SET status = ?, error = ?, updated_at = ? WHERE command_id = ?;",
      status,
      error ?? null,
      now,
      commandId,
    );
  }

  syncLogger.debug("CommandOutbox", "Status updated", { commandId, status });
}

export async function markCommandInFlight(
  db: SQLiteDatabase,
  commandId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db.runAsync(
    `
      UPDATE commands
      SET status = 'in_flight', last_attempted_at = ?, updated_at = ?
      WHERE command_id = ?;
    `,
    now,
    now,
    commandId,
  );
}

export async function deleteCommand(
  db: SQLiteDatabase,
  commandId: string,
): Promise<void> {
  await db.runAsync("DELETE FROM commands WHERE command_id = ?;", commandId);
}

export async function clearCompletedCommands(
  db: SQLiteDatabase,
  olderThanHours = 24,
): Promise<void> {
  const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString();
  await db.runAsync(
    "DELETE FROM commands WHERE status = 'completed' AND updated_at < ?;",
    cutoff,
  );
}

// ─────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────

export interface InsertEventInput {
  event: DomainEvent;
  origin: "local" | "cloud" | "lan";
  syncedToCloud?: boolean;
}

export async function insertEvent(
  db: SQLiteDatabase,
  input: InsertEventInput,
): Promise<void> {
  const { event, origin, syncedToCloud = false } = input;
  await db.runAsync(
    `
      INSERT INTO events (
        event_id, event_type, event_version, entity_id, user_id, device_id,
        payload, origin, synced_to_cloud, timestamp, persisted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING;
    `,
    event.event_id,
    event.event_type,
    event.event_version,
    event.entity_id,
    event.user_id,
    event.device_id,
    JSON.stringify(event.payload),
    origin,
    syncedToCloud ? 1 : 0,
    event.timestamp,
    new Date().toISOString(),
  );

  syncLogger.event(event, "persisted", { origin, syncedToCloud });
}

export async function getEventsForEntity(
  db: SQLiteDatabase,
  entityId: string,
  limit = 100,
): Promise<DomainEvent[]> {
  const rows = await db.getAllAsync<EventRow>(
    `
      SELECT * FROM events
      WHERE entity_id = ?
      ORDER BY timestamp ASC
      LIMIT ?;
    `,
    entityId,
    limit,
  );
  return rows.map(rowToDomainEvent);
}

export async function getUnsyncedEvents(
  db: SQLiteDatabase,
  origin: "local" | "lan" = "local",
  limit = 100,
): Promise<DomainEvent[]> {
  const rows = await db.getAllAsync<EventRow>(
    `
      SELECT * FROM events
      WHERE origin = ? AND synced_to_cloud = 0
      ORDER BY timestamp ASC
      LIMIT ?;
    `,
    origin,
    limit,
  );
  return rows.map(rowToDomainEvent);
}

export async function markEventsSynced(
  db: SQLiteDatabase,
  eventIds: string[],
): Promise<void> {
  if (eventIds.length === 0) return;
  const placeholders = eventIds.map(() => "?").join(",");
  await db.runAsync(
    `UPDATE events SET synced_to_cloud = 1 WHERE event_id IN (${placeholders});`,
    ...eventIds,
  );
}

// ─────────────────────────────────────────────────────────────
// Entity snapshots (local read model)
// ─────────────────────────────────────────────────────────────

export interface EntitySnapshot<T = unknown> {
  entity_type: string;
  entity_id: string;
  business_id: string | null;
  last_event_id: string;
  last_event_timestamp: string;
  payload: T;
}

interface EntitySnapshotRow {
  entity_type: string;
  entity_id: string;
  business_id: string | null;
  last_event_id: string;
  last_event_timestamp: string;
  payload: string;
}

function rowToEntitySnapshot<T>(row: EntitySnapshotRow): EntitySnapshot<T> {
  return {
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    business_id: row.business_id,
    last_event_id: row.last_event_id,
    last_event_timestamp: row.last_event_timestamp,
    payload: JSON.parse(row.payload) as T,
  };
}

export interface UpsertEntitySnapshotInput<T = unknown> {
  entityType: string;
  entityId: string;
  businessId?: string | null;
  lastEventId: string;
  lastEventTimestamp: string;
  payload: T;
}

export async function upsertEntitySnapshot<T>(
  db: SQLiteDatabase,
  input: UpsertEntitySnapshotInput<T>,
): Promise<void> {
  const {
    entityType,
    entityId,
    businessId = null,
    lastEventId,
    lastEventTimestamp,
    payload,
  } = input;

  const existing = await db.getFirstAsync<EntitySnapshotRow>(
    "SELECT last_event_timestamp FROM entity_snapshots WHERE entity_type = ? AND entity_id = ?;",
    entityType,
    entityId,
  );

  if (existing && existing.last_event_timestamp > lastEventTimestamp) {
    return;
  }

  await db.runAsync(
    `
      INSERT INTO entity_snapshots (entity_type, entity_id, business_id, last_event_id, last_event_timestamp, payload)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        business_id = excluded.business_id,
        last_event_id = excluded.last_event_id,
        last_event_timestamp = excluded.last_event_timestamp,
        payload = excluded.payload;
    `,
    entityType,
    entityId,
    businessId,
    lastEventId,
    lastEventTimestamp,
    JSON.stringify(payload),
  );
}

export async function getEntitySnapshot<T>(
  db: SQLiteDatabase,
  entityType: string,
  entityId: string,
  businessId?: string | null,
): Promise<EntitySnapshot<T> | null> {
  if (businessId) {
    const row = await db.getFirstAsync<EntitySnapshotRow>(
      "SELECT * FROM entity_snapshots WHERE entity_type = ? AND entity_id = ? AND business_id = ?;",
      entityType,
      entityId,
      businessId,
    );
    if (row) return rowToEntitySnapshot<T>(row);
  }
  const row = await db.getFirstAsync<EntitySnapshotRow>(
    "SELECT * FROM entity_snapshots WHERE entity_type = ? AND entity_id = ?;",
    entityType,
    entityId,
  );
  return row ? rowToEntitySnapshot<T>(row) : null;
}

export async function getEntitySnapshotsByType<T>(
  db: SQLiteDatabase,
  entityType: string,
  businessId?: string | null,
): Promise<EntitySnapshot<T>[]> {
  if (businessId) {
    const rows = await db.getAllAsync<EntitySnapshotRow>(
      "SELECT * FROM entity_snapshots WHERE entity_type = ? AND business_id = ? ORDER BY last_event_timestamp DESC;",
      entityType,
      businessId,
    );
    return rows.map(rowToEntitySnapshot<T>);
  }
  const rows = await db.getAllAsync<EntitySnapshotRow>(
    "SELECT * FROM entity_snapshots WHERE entity_type = ? ORDER BY last_event_timestamp DESC;",
    entityType,
  );
  return rows.map(rowToEntitySnapshot<T>);
}

export async function deleteEntitySnapshot(
  db: SQLiteDatabase,
  entityType: string,
  entityId: string,
): Promise<void> {
  await db.runAsync(
    "DELETE FROM entity_snapshots WHERE entity_type = ? AND entity_id = ?;",
    entityType,
    entityId,
  );
}

export async function pruneEntitySnapshots(
  db: SQLiteDatabase,
  entityType: string,
  cutoffIso: string,
): Promise<void> {
  await db.runAsync(
    "DELETE FROM entity_snapshots WHERE entity_type = ? AND last_event_timestamp < ?;",
    entityType,
    cutoffIso,
  );
}

// ─────────────────────────────────────────────────────────────
// Row mappers
// ─────────────────────────────────────────────────────────────

interface PersistedCommandRow {
  id: number;
  command_id: string;
  command_type: string;
  command_version: string;
  business_id: string;
  entity_id: string | null;
  user_id: string;
  device_id: string;
  payload: string;
  status: PersistedCommand["status"];
  error: string | null;
  retry_count: number;
  last_attempted_at: string | null;
  timestamp: string;
  created_at: string;
  updated_at: string;
}

function rowToPersistedCommand(row: PersistedCommandRow): PersistedCommand {
  return {
    id: row.id,
    command_id: row.command_id,
    command_type: row.command_type,
    command_version: row.command_version,
    business_id: row.business_id,
    entity_id: row.entity_id ?? undefined,
    user_id: row.user_id,
    device_id: row.device_id,
    payload: JSON.parse(row.payload),
    status: row.status,
    error: row.error,
    retry_count: row.retry_count,
    last_attempted_at: row.last_attempted_at ?? undefined,
    timestamp: row.timestamp,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface EventRow {
  event_id: string;
  event_type: string;
  event_version: string;
  entity_id: string;
  user_id: string;
  device_id: string;
  payload: string;
  origin: "local" | "cloud" | "lan";
  synced_to_cloud: number;
  timestamp: string;
  persisted_at: string;
}

function rowToDomainEvent(row: EventRow): DomainEvent {
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    event_version: row.event_version,
    entity_id: row.entity_id,
    user_id: row.user_id,
    device_id: row.device_id,
    payload: JSON.parse(row.payload),
    timestamp: row.timestamp,
  };
}

// ─────────────────────────────────────────────────────────────
// Orders — real local DB (primary, like backend)
// ─────────────────────────────────────────────────────────────

export interface OrderRow {
  id: string;
  business_id: string;
  order_number: string;
  callout_number: number | null;
  status: string;
  order_type: string | null;
  is_pos: number;
  items: string;
  subtotal_minor: number;
  total_minor: number;
  tax_minor: number;
  tax_lines: string | null;
  payment: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  pos_payment_method: string | null;
  delivery_id: string | null;
  business: string | null;
  user: string | null;
  inserted_at: string;
  updated_at: string | null;
  hlc: string | null;
  deleted_at: string | null;
}

function orderRowToSellerOrder(row: OrderRow): import("../types/api/seller.api").SellerOrder {
  return {
    id: row.id,
    business_id: row.business_id,
    order_number: row.order_number,
    callout_number: row.callout_number,
    status: row.status,
    order_type: row.order_type,
    is_pos: !!row.is_pos,
    items: row.items ? JSON.parse(row.items) : [],
    subtotal_minor: row.subtotal_minor,
    total_minor: row.total_minor,
    tax_minor: row.tax_minor,
    tax_lines: row.tax_lines ? JSON.parse(row.tax_lines) : [],
    payment: row.payment ? JSON.parse(row.payment) : { is_paid: false, reference: null, amount_minor: null, currency: null, paid_at: null },
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    pos_payment_method: row.pos_payment_method,
    delivery_id: row.delivery_id,
    business: row.business ? JSON.parse(row.business) : null,
    delivery_address: null,
    delivery_lat: null,
    delivery_lng: null,
    user: row.user ? JSON.parse(row.user) : null,
    currency: (row.payment ? JSON.parse(row.payment).currency : "GHS") ?? "GHS",
    currency_code: (row.payment ? JSON.parse(row.payment).currency : "GHS") ?? "GHS",
    discount_minor: 0,
    promo_code: null,
    tip_minor: null,
    delivery_fee_minor: 0,
    delivery_status: null,
    is_paid: row.payment ? JSON.parse(row.payment).is_paid ?? false : false,
    paid_at: row.payment ? JSON.parse(row.payment).paid_at ?? null : null,
    inserted_at: row.inserted_at,
    updated_at: row.updated_at ?? row.inserted_at,
  } as unknown as import("../types/api/seller.api").SellerOrder;
}

export async function insertOrder(db: SQLiteDatabase, order: import("../types/api/seller.api").SellerOrder & { hlc?: string }): Promise<void> {
  const hlc = (order as unknown as { hlc?: string }).hlc ?? new Date().toISOString();
  const updatedAt = order.updated_at ?? order.inserted_at;
  await db.runAsync(
    `INSERT INTO orders (id, business_id, order_number, callout_number, status, order_type, is_pos, items, subtotal_minor, total_minor, tax_minor, tax_lines, payment, customer_name, customer_phone, pos_payment_method, delivery_id, business, user, inserted_at, updated_at, hlc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET business_id=excluded.business_id, order_number=excluded.order_number, callout_number=excluded.callout_number, status=excluded.status, order_type=excluded.order_type, is_pos=excluded.is_pos, items=excluded.items, subtotal_minor=excluded.subtotal_minor, total_minor=excluded.total_minor, tax_minor=excluded.tax_minor, tax_lines=excluded.tax_lines, payment=excluded.payment, customer_name=excluded.customer_name, customer_phone=excluded.customer_phone, pos_payment_method=excluded.pos_payment_method, delivery_id=excluded.delivery_id, business=excluded.business, user=excluded.user, updated_at=excluded.updated_at, hlc=excluded.hlc
     WHERE excluded.hlc >= orders.hlc OR orders.hlc IS NULL;`,
    order.id, order.business_id, order.order_number, order.callout_number, order.status, order.order_type, order.is_pos ? 1 : 0,
    JSON.stringify(order.items), order.subtotal_minor, order.total_minor, order.tax_minor, JSON.stringify(order.tax_lines), JSON.stringify(order.payment),
    order.customer_name, order.customer_phone, order.pos_payment_method, order.delivery_id, order.business ? JSON.stringify(order.business) : null, order.user ? JSON.stringify(order.user) : null,
    order.inserted_at, updatedAt, hlc
  );
}

export async function getOrderById(db: SQLiteDatabase, businessId: string, idOrNumber: string): Promise<import("../types/api/seller.api").SellerOrder | null> {
  const row = await db.getFirstAsync<OrderRow>(`SELECT * FROM orders WHERE business_id = ? AND (id = ? OR order_number = ?) LIMIT 1;`, businessId, idOrNumber, idOrNumber);
  return row ? orderRowToSellerOrder(row) : null;
}

export async function listOrders(db: SQLiteDatabase, businessId: string, filters?: { status?: string; q?: string; is_pos?: string; order_type?: string }, page = 1, pageSize = 20): Promise<{ data: import("../types/api/seller.api").SellerOrder[]; total: number }> {
  const where: string[] = ["business_id = ?"];
  const args: unknown[] = [businessId];
  if (filters?.status) {
    const statuses = filters.status.split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length) { where.push(`status IN (${statuses.map(() => "?").join(",")})`); args.push(...statuses); }
  }
  if (filters?.is_pos != null) { where.push("is_pos = ?"); args.push(filters.is_pos === "true" || filters.is_pos === "1" ? 1 : 0); }
  if (filters?.order_type) { where.push("order_type = ?"); args.push(filters.order_type); }
  if (filters?.q) { where.push("(order_number LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)"); const q = `%${filters.q}%`; args.push(q, q, q); }
  const whereSql = where.join(" AND ");
  const countRow = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(*) as c FROM orders WHERE ${whereSql};`, ...args);
  const total = countRow?.c ?? 0;
  const offset = (page - 1) * pageSize;
  const rows = await db.getAllAsync<OrderRow>(`SELECT * FROM orders WHERE ${whereSql} ORDER BY inserted_at DESC LIMIT ? OFFSET ?;`, ...args, pageSize, offset);
  return { data: rows.map(orderRowToSellerOrder), total };
}

export async function updateOrderStatus(db: SQLiteDatabase, businessId: string, orderId: string, toStatus: string, hlc?: string): Promise<void> {
  const now = hlc ?? new Date().toISOString();
  await db.runAsync(`UPDATE orders SET status = ?, hlc = ? WHERE business_id = ? AND (id = ? OR order_number = ?);`, toStatus, now, businessId, orderId, orderId);
}

export async function updateOrderPayment(db: SQLiteDatabase, businessId: string, orderId: string, patch: { is_paid: boolean; paid_at: string | null }): Promise<void> {
  const row = await getOrderById(db, businessId, orderId);
  if (!row) return;
  const payment = { ...(row.payment as object), is_paid: patch.is_paid, paid_at: patch.paid_at } as unknown as string;
  await db.runAsync(`UPDATE orders SET payment = ?, hlc = ? WHERE business_id = ? AND (id = ? OR order_number = ?);`, JSON.stringify(payment), new Date().toISOString(), businessId, orderId, orderId);
}

// ─────────────────────────────────────────────────────────────
// Maintenance — clear stale local data (used by Diagnostics)
// ─────────────────────────────────────────────────────────────

export async function clearAllSyncData(db: SQLiteDatabase): Promise<void> {
  // New-DB primary: orders + sync_jobs. Keep legacy deletes guarded (v8 dropped them).
  try { await db.execAsync(`DELETE FROM orders;`); } catch {}
  try { await db.execAsync(`DELETE FROM sync_jobs;`); } catch {}
  try { await db.execAsync(`DELETE FROM entity_snapshots;`); } catch {}
  try { await db.execAsync(`DELETE FROM commands;`); } catch {}
  try { await db.execAsync(`DELETE FROM events;`); } catch {}
  // Keep reference_data by default (expensive to re-fetch). Use wipeForNewInstall for full reset.
}

export async function wipeForNewInstall(db: SQLiteDatabase): Promise<void> {
  try { await db.execAsync(`DELETE FROM orders;`); } catch {}
  try { await db.execAsync(`DELETE FROM sync_jobs;`); } catch {}
  try { await db.execAsync(`DELETE FROM entity_snapshots;`); } catch {}
  try { await db.execAsync(`DELETE FROM reference_data;`); } catch {}
  try { await db.execAsync(`DELETE FROM commands;`); } catch {}
  try { await db.execAsync(`DELETE FROM events;`); } catch {}
  try { await db.execAsync(`DELETE FROM migrations WHERE version >= 5;`); } catch {}
}

export async function clearReferenceData(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`DELETE FROM reference_data;`);
}

export async function clearCompletedCommandsAndOrphans(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`DELETE FROM commands WHERE status = 'completed';`);
  try {
    await db.execAsync(`DELETE FROM commands WHERE payload LIKE '%TFL-%';`);
  } catch {}
  try {
    await db.execAsync(`DELETE FROM events WHERE payload LIKE '%TFL-%';`);
  } catch {}
}
