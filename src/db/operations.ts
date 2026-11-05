/**
 * Low-level SQLite operations for the command outbox and event journal.
 */

import type { SQLiteDatabase, SQLiteRunResult } from "../adapters/sqlite";
import type { Command, DomainEvent, PersistedCommand } from "../sync/types";
import { syncLogger } from "../utils/sync-logger";
import { getQueuedStatus } from "../utils/order-transitions";

/** Target status a queued command will produce on the server. */
function queuedStatusOf(commandType: string): string | null {
  return getQueuedStatus(commandType);
}

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
  includeFailed = false,
): Promise<PersistedCommand[]> {
  // `failed` rows are terminal (permanent rejection / retries exhausted) — they
  // must NOT be re-fetched by the replay loop, or every failed command would be
  // re-POSTed and re-toasted on each pass. Diagnostics opts in via
  // includeFailed for the full outbox dump.
  const statuses = includeFailed ? "('pending', 'failed')" : "('pending')";
  const rows = await db.getAllAsync<PersistedCommandRow>(
    `
      SELECT * FROM commands
      WHERE status IN ${statuses}
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
  incrementRetry?: boolean,
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
  } else if (incrementRetry) {
    // Bounded 4xx retries count attempts without failing the row, so
    // MAX_RETRIES caps blind retries while 5xx/network stay indefinite.
    await db.runAsync(
      "UPDATE commands SET status = ?, error = ?, retry_count = retry_count + 1, updated_at = ? WHERE command_id = ?;",
      status,
      error ?? null,
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
  notifyDbChange(businessId ?? undefined, `entity_snapshots:${entityType}`);
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
  payment_mode: string | null;
  delivery_id: string | null;
  business: string | null;
  user: string | null;
  inserted_at: string;
  updated_at: string | null;
  hlc: string | null;
  paid_at?: string | null;
  deleted_at: string | null;
  sync_failed_at?: string | null;
  sync_error?: string | null;
}

const EMPTY_PAYMENT = {
  is_paid: false,
  reference: null,
  amount_minor: null,
  currency: null,
  paid_at: null,
} as const;

/**
 * Effective payment of a stored order.
 *
 * `payment` (server payment summary) is the primary shape, but the order's
 * own `paid_at` column wins when the server did not report a payment. Cash
 * sales taken at a POS terminal only carry `paid_at` — no payment
 * transaction — so reading the blob alone made them look unpaid.
 */
function paymentStateOf(row: OrderRow): {
  payment: Record<string, unknown>;
  isPaid: boolean;
  paidAt: string | null;
} {
  let parsed: Record<string, unknown> = {};
  if (row.payment) {
    try {
      const value = JSON.parse(row.payment);
      if (value && typeof value === "object") parsed = value as Record<string, unknown>;
    } catch {}
  }
  const payment: Record<string, unknown> = { ...EMPTY_PAYMENT, ...parsed };
  const paidAt =
    (payment.paid_at as string | null | undefined) ?? row.paid_at ?? null;
  const isPaid = payment.is_paid === true || !!paidAt;
  return { payment: { ...payment, paid_at: paidAt, is_paid: isPaid }, isPaid, paidAt };
}

/** True when the order has any recorded payment. */
export function isOrderPaid(order: { is_paid?: boolean; paid_at?: string | null; payment?: unknown } | null | undefined): boolean {
  if (!order) return false;
  if (order.is_paid === true || order.paid_at) return true;
  const payment = order.payment as { is_paid?: boolean; paid_at?: string | null } | undefined;
  return payment?.is_paid === true || !!payment?.paid_at;
}

function orderRowToSellerOrder(row: OrderRow): import("../types/api/seller.api").SellerOrder {
  const { payment, isPaid, paidAt } = paymentStateOf(row);
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
    payment,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    pos_payment_method: row.pos_payment_method,
    payment_mode: row.payment_mode ?? "prepaid",
    delivery_id: row.delivery_id,
    business: row.business ? JSON.parse(row.business) : null,
    delivery_address: null,
    delivery_lat: null,
    delivery_lng: null,
    user: row.user ? JSON.parse(row.user) : null,
    currency: (payment.currency as string | null) ?? "GHS",
    currency_code: (payment.currency as string | null) ?? "GHS",
    discount_minor: 0,
    promo_code: null,
    tip_minor: null,
    delivery_fee_minor: 0,
    delivery_status: null,
    is_paid: isPaid,
    paid_at: paidAt,
    inserted_at: row.inserted_at,
    updated_at: row.updated_at ?? row.inserted_at,
    sync_failed_at: row.sync_failed_at ?? null,
    sync_error: row.sync_error ?? null,
  } as unknown as import("../types/api/seller.api").SellerOrder;
}

export async function insertOrder(db: SQLiteDatabase, order: import("../types/api/seller.api").SellerOrder & { hlc?: string }): Promise<void> {
  const hlc = (order as unknown as { hlc?: string }).hlc ?? new Date().toISOString();
  const updatedAt = order.updated_at ?? order.inserted_at;
  const paidAt =
    order.paid_at ??
    (order.payment as { paid_at?: string | null } | undefined)?.paid_at ??
    (isOrderPaid(order) ? updatedAt : null);
  await db.runAsync(
    `INSERT INTO orders (id, business_id, order_number, callout_number, status, order_type, is_pos, items, subtotal_minor, total_minor, tax_minor, tax_lines, payment, paid_at, customer_name, customer_phone, pos_payment_method, payment_mode, delivery_id, business, user, inserted_at, updated_at, hlc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET business_id=excluded.business_id, order_number=excluded.order_number, callout_number=excluded.callout_number, status=excluded.status, order_type=excluded.order_type, is_pos=excluded.is_pos, items=excluded.items, subtotal_minor=excluded.subtotal_minor, total_minor=excluded.total_minor, tax_minor=excluded.tax_minor, tax_lines=excluded.tax_lines, payment=excluded.payment, paid_at=COALESCE(excluded.paid_at, orders.paid_at), customer_name=excluded.customer_name, customer_phone=excluded.customer_phone, pos_payment_method=excluded.pos_payment_method, payment_mode=excluded.payment_mode, delivery_id=excluded.delivery_id, business=excluded.business, user=excluded.user, updated_at=excluded.updated_at, hlc=excluded.hlc, sync_failed_at=NULL, sync_error=NULL
     WHERE excluded.hlc >= orders.hlc OR orders.hlc IS NULL;`,
    order.id, order.business_id, order.order_number, order.callout_number, order.status, order.order_type, order.is_pos ? 1 : 0,
    JSON.stringify(order.items), order.subtotal_minor, order.total_minor, order.tax_minor, JSON.stringify(order.tax_lines), JSON.stringify(order.payment), paidAt,
    order.customer_name, order.customer_phone, order.pos_payment_method, order.payment_mode ?? null,
    order.delivery_id, order.business ? JSON.stringify(order.business) : null, order.user ? JSON.stringify(order.user) : null,
    order.inserted_at, updatedAt, hlc
  );
  notifyDbChange(order.business_id, "orders");
}

export async function getOrderById(db: SQLiteDatabase, businessId: string, idOrNumber: string): Promise<import("../types/api/seller.api").SellerOrder | null> {
  const row = await db.getFirstAsync<OrderRow>(`SELECT * FROM orders WHERE business_id = ? AND (id = ? OR order_number = ?) LIMIT 1;`, businessId, idOrNumber, idOrNumber);
  return row ? orderRowToSellerOrder(row) : null;
}

/**
 * Local intent for an order that still has unsynced work in `sync_jobs`.
 *
 * While a command is queued the device's intent must win over the server
 * copy: a pull that lands before the command syncs would otherwise revert a
 * queued accept (or a queued cash payment) back to the server's older state.
 *
 * `status` is the target status of the LAST queued transition, `isPaid` is
 * true when a cash confirmation is still queued.
 */
export interface PendingOrderIntent {
  status: string | null;
  isPaid: boolean;
  hasPending: boolean;
}

export async function getPendingOrderIntent(
  db: SQLiteDatabase,
  businessId: string,
  orderId: string,
): Promise<PendingOrderIntent> {
  const empty: PendingOrderIntent = { status: null, isPaid: false, hasPending: false };
  try {
    const rows = await db.getAllAsync<{ command_type: string; payload: string | null }>(
      `SELECT command_type, payload FROM sync_jobs WHERE business_id = ? AND entity_id = ? AND status = 'pending' ORDER BY created_at ASC, rowid ASC;`,
      businessId,
      orderId,
    );
    if (!rows.length) return empty;
    let status: string | null = null;
    let isPaid = false;
    for (const row of rows) {
      const commandType = row.command_type ?? "";
      const target = queuedStatusOf(commandType);
      if (target) status = target;
      if (commandType === "payment:confirm_cash" || commandType === "order:confirm_cash") {
        isPaid = true;
      }
      // A cash sale is paid at the moment it is rung up — the queued create
      // itself is the record of that intent. Without this, a pull landing
      // before the create reaches the backend replaces the paid local row
      // with the server's (older, unpaid) copy.
      if (commandType === "order:create") {
        try {
          const payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : null;
          const method = (payload?.pos_payment_method as string | undefined) ?? "cash";
          if (method === "cash") isPaid = true;
        } catch {}
      }
    }
    return { status, isPaid, hasPending: true };
  } catch {
    return empty;
  }
}

/**
 * Write a server order into the local read model.
 *
 * Unlike `insertOrder` (which is HLC-guarded for local/LAN writes), the
 * server copy is authoritative: it always overwrites the row. The only
 * exception is an order with unsynced local work — its status and payment
 * stay as the device intended until the queued command is acknowledged.
 *
 * The HLC is taken from the server's own `updated_at` so device clock skew
 * can never make a fresh server state look stale.
 */
export async function upsertServerOrder(
  db: SQLiteDatabase,
  order: import("../types/api/seller.api").SellerOrder,
  opts: { preserveStatus?: boolean; preservePayment?: boolean } = {},
): Promise<void> {
  if (!order?.id || !order?.business_id) return;
  const existing = await getOrderById(db, order.business_id, order.id);
  const status = opts.preserveStatus && existing ? existing.status : order.status;

  const serverPayment = (order.payment ?? {}) as {
    is_paid?: boolean;
    paid_at?: string | null;
    reference?: string | null;
    amount_minor?: number | null;
    currency?: string | null;
  };
  const serverPaidAt = order.paid_at ?? serverPayment.paid_at ?? null;
  const serverIsPaid =
    order.is_paid === true || !!serverPaidAt || serverPayment.is_paid === true;

  let payment: Record<string, unknown>;
  if (
    existing &&
    (opts.preservePayment || (!serverIsPaid && isOrderPaid(existing)))
  ) {
    // Keep the device's payment. A pull must never un-pay an order: the
    // server copy of a cash sale rung up moments ago can lag behind, and it
    // used to reset the row to UNPAID until the create finished syncing.
    payment = { ...(existing.payment as unknown as Record<string, unknown>) };
  } else {
    payment = {
      ...serverPayment,
      is_paid: serverIsPaid,
      paid_at: serverPaidAt,
      amount_minor: serverPayment.amount_minor ?? order.total_minor ?? null,
      currency: serverPayment.currency ?? order.currency_code ?? null,
    };
  }
  const paidAt = (payment.paid_at as string | null | undefined) ?? null;

  const hlc =
    (order as unknown as { hlc?: string }).hlc ??
    order.updated_at ??
    order.inserted_at ??
    new Date().toISOString();
  const updatedAt = order.updated_at ?? order.inserted_at;
  await db.runAsync(
    `INSERT INTO orders (id, business_id, order_number, callout_number, status, order_type, is_pos, items, subtotal_minor, total_minor, tax_minor, tax_lines, payment, paid_at, customer_name, customer_phone, pos_payment_method, payment_mode, delivery_id, business, user, inserted_at, updated_at, hlc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET business_id=excluded.business_id, order_number=excluded.order_number, callout_number=excluded.callout_number, status=excluded.status, order_type=excluded.order_type, is_pos=excluded.is_pos, items=excluded.items, subtotal_minor=excluded.subtotal_minor, total_minor=excluded.total_minor, tax_minor=excluded.tax_minor, tax_lines=excluded.tax_lines, payment=excluded.payment, paid_at=COALESCE(excluded.paid_at, orders.paid_at), customer_name=excluded.customer_name, customer_phone=excluded.customer_phone, pos_payment_method=excluded.pos_payment_method, payment_mode=excluded.payment_mode, delivery_id=excluded.delivery_id, business=excluded.business, user=excluded.user, updated_at=excluded.updated_at, hlc=excluded.hlc, sync_failed_at=NULL, sync_error=NULL;`,
    order.id, order.business_id, order.order_number, order.callout_number, status, order.order_type, order.is_pos ? 1 : 0,
    JSON.stringify(order.items ?? []), order.subtotal_minor ?? 0, order.total_minor ?? 0, order.tax_minor ?? 0,
    JSON.stringify(order.tax_lines ?? []), JSON.stringify(payment), paidAt,
    order.customer_name, order.customer_phone, order.pos_payment_method,
    order.payment_mode ?? (order.is_pos ? "prepaid" : "prepaid"), order.delivery_id,
    order.business ? JSON.stringify(order.business) : null, order.user ? JSON.stringify(order.user) : null,
    order.inserted_at, updatedAt, hlc,
  );
  notifyDbChange(order.business_id, "orders");
}

/**
 * Recent orders plus their local HLC, for LAN catch-up.
 *
 * The HLC must travel with the row: `insertOrder` is HLC-guarded, so a peer
 * replaying an older snapshot can never overwrite a newer local status.
 */
export async function listOrdersWithHlc(
  db: SQLiteDatabase,
  businessId: string,
  limit = 200,
): Promise<Array<import("../types/api/seller.api").SellerOrder & { hlc?: string }>> {
  const rows = await db.getAllAsync<OrderRow>(
    `SELECT * FROM orders WHERE business_id = ? AND deleted_at IS NULL ORDER BY inserted_at DESC, rowid DESC LIMIT ?;`,
    businessId,
    limit,
  );
  return rows.map((row) => ({
    ...orderRowToSellerOrder(row),
    hlc: row.hlc ?? row.updated_at ?? row.inserted_at,
  }));
}

export async function listOrders(db: SQLiteDatabase, businessId: string, filters?: { status?: string; q?: string; is_pos?: string; order_type?: string; date_from?: string; date_to?: string; is_paid?: string }, page = 1, pageSize = 20): Promise<{ data: import("../types/api/seller.api").SellerOrder[]; total: number }> {
  const where: string[] = ["business_id = ?"];
  const args: unknown[] = [businessId];
  if (filters?.status) {
    const statuses = filters.status.split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length) { where.push(`status IN (${statuses.map(() => "?").join(",")})`); args.push(...statuses); }
  }
  if (filters?.is_pos != null) { where.push("is_pos = ?"); args.push(filters.is_pos === "true" || filters.is_pos === "1" ? 1 : 0); }
  if (filters?.order_type) { where.push("order_type = ?"); args.push(filters.order_type); }
  // Paid means "the order has a payment timestamp" (cash at the till) or the
  // payment blob says so (gateway payment) — mirroring the backend filter.
  if (filters?.is_paid === "paid") { where.push("(json_extract(payment, '$.is_paid') = 1 OR paid_at IS NOT NULL)"); }
  else if (filters?.is_paid === "unpaid") { where.push("(COALESCE(json_extract(payment, '$.is_paid'), 0) = 0 AND paid_at IS NULL)"); }
  if (filters?.q) { where.push("(order_number LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)"); const q = `%${filters.q}%`; args.push(q, q, q); }
  if (filters?.date_from) { where.push("inserted_at >= ?"); args.push(filters.date_from); }
  if (filters?.date_to) { where.push("inserted_at < ?"); args.push(`${filters.date_to}T23:59:59`); }
  const whereSql = where.join(" AND ");
  const countRow = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(*) as c FROM orders WHERE ${whereSql};`, ...args);
  const total = countRow?.c ?? 0;
  const offset = (page - 1) * pageSize;
  const rows = await db.getAllAsync<OrderRow>(`SELECT * FROM orders WHERE ${whereSql} ORDER BY inserted_at DESC, rowid DESC LIMIT ? OFFSET ?;`, ...args, pageSize, offset);
  return { data: rows.map(orderRowToSellerOrder), total };
}

export async function updateOrderStatus(db: SQLiteDatabase, businessId: string, orderId: string, toStatus: string, hlc?: string): Promise<void> {
  const now = hlc ?? new Date().toISOString();
  await db.runAsync(`UPDATE orders SET status = ?, hlc = ? WHERE business_id = ? AND (id = ? OR order_number = ?);`, toStatus, now, businessId, orderId, orderId);
  notifyDbChange(businessId, "orders");
}

/**
 * Flag an order whose queued work dead-lettered (parent create failed, or a
 * transition 404'd because the server has no such order). The row is kept for
 * audit rather than deleted; a later pull of the real order clears the flag.
 */
export async function markOrderSyncFailed(db: SQLiteDatabase, businessId: string, orderId: string, message: string): Promise<void> {
  try {
    await db.runAsync(
      `UPDATE orders SET sync_failed_at = ?, sync_error = ? WHERE business_id = ? AND (id = ? OR order_number = ?);`,
      new Date().toISOString(),
      message,
      businessId,
      orderId,
      orderId,
    );
    notifyDbChange(businessId, "orders");
  } catch {}
}

export async function updateOrderPayment(db: SQLiteDatabase, businessId: string, orderId: string, patch: { is_paid: boolean; paid_at: string | null }): Promise<void> {
  const row = await getOrderById(db, businessId, orderId);
  if (!row) return;
  const payment = { ...(row.payment as object), is_paid: patch.is_paid, paid_at: patch.paid_at } as unknown as string;
  await db.runAsync(
    `UPDATE orders SET payment = ?, paid_at = COALESCE(?, paid_at), hlc = ? WHERE business_id = ? AND (id = ? OR order_number = ?);`,
    JSON.stringify(payment),
    patch.is_paid ? patch.paid_at : null,
    new Date().toISOString(),
    businessId,
    orderId,
    orderId,
  );
  notifyDbChange(businessId, "orders");
}

/**
 * Patch delivery linkage from realtime delivery events (delivery.assigned /
 * delivery.status_changed / delivery.pickup_confirmed) so every terminal
 * converges on assign-vs-handover branching without a refetch.
 */
export async function updateOrderDelivery(db: SQLiteDatabase, businessId: string, orderId: string, patch: { delivery_id?: string | null }): Promise<void> {
  if (patch.delivery_id === undefined) return;
  await db.runAsync(`UPDATE orders SET delivery_id = ?, hlc = ? WHERE business_id = ? AND (id = ? OR order_number = ?);`, patch.delivery_id, new Date().toISOString(), businessId, orderId, orderId);
  notifyDbChange(businessId, "orders");
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

const dbChangeListeners = new Set<(info: { businessId?: string; table: string }) => void>();
export function subscribeDbChanges(listener: (info: { businessId?: string; table: string }) => void): () => void {
  dbChangeListeners.add(listener);
  return () => dbChangeListeners.delete(listener);
}
export function notifyDbChange(businessId: string | undefined, table: string): void {
  for (const l of dbChangeListeners) try { l({ businessId, table }); } catch {}
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
