/**
 * @teincfood/core — shared offline-first backbone
 *
 * Entry point. Re-exports types, sync engine, DB, reference service, repos and adapters.
 * Host apps call `createTeincCore` once at bootstrap to wire platform adapters.
 */

// ── Types ──
export * from "./types/api";
export * from "./types/pos.types";

// ── Utils ──
export * from "./utils/constants";
export * from "./utils/currency";
export * from "./utils/error";
export * from "./utils/uuid";
export * from "./utils/sync-logger";
export * from "./utils/phone";
export * from "./utils/formatCurrency";
export * from "./utils/formatDate";
export * from "./utils/validation";
export * from "./utils/responsive";
export * from "./utils/copyToClipBoard";

// ── DB ──
export * from "./db/migrations";
export * from "./db/operations";
export * as dbOps from "./db/operations";
export { openSyncDatabase, getSyncDatabase } from "./db/connection";

// ── Sync ──
export * from "./sync/types";
export { SyncEngine, syncEngine } from "./sync/engine";
export * from "./sync/command-builder";
export * from "./sync/command-queue.service";
export { commandQueueService } from "./sync/command-queue.service";
export { buildCommand } from "./sync/command-builder";
export { generateLocalOrderNumber, generateLocalCalloutNumber, isLocalOrderNumber } from "./sync/order-number";
export { orderSnapshotsService } from "./sync/order-snapshots.service";
export * from "./sync/pending-orders.service";
export * from "./sync/transport-rest";
export * from "./sync/transport-local-node";
export * from "./sync/order-snapshots.service";

// ── Repositories ──
export { orderRepository } from "./repositories/order.repository";
export { posRepository } from "./repositories/pos.repository";

// ── Reference ──
export * from "./reference/types";
export * from "./reference/operations";
export * from "./reference/events";
export * from "./reference/service";
export { referenceSyncService } from "./reference/service";

// ── Adapters (for host apps to supply) ──
export * from "./adapters/sqlite";
export * from "./adapters/kv";
export * from "./adapters/connectivity";
export * from "./adapters/http";
export * from "./adapters/local-node";
export * from "./adapters/services";
export * from "./adapters/devices";
export * from "./adapters/image-cache";

// ── Init helper ──
import { setSqliteDriver, type SqliteDriver } from "./adapters/sqlite";
import { setKVDriver, type KVDriver } from "./adapters/kv";
import { setConnectivityState } from "./adapters/connectivity";
import { setHttpClient, type HttpClient } from "./adapters/http";
import { SyncEngine } from "./sync/engine";
import { restTransport } from "./sync/transport-rest";
import { localNodeTransport } from "./sync/transport-local-node";

export interface CoreConfig {
  sqliteDriver?: SqliteDriver;
  kvDriver?: KVDriver;
  httpClient?: HttpClient;
  /** Optional initial connectivity override */
  initialConnectivity?: { isOnline?: boolean; isCloudReachable?: "reachable" | "unreachable" | "unknown" };
}

let engine: SyncEngine | null = null;

export function createTeincCore(config: CoreConfig = {}): { engine: SyncEngine } {
  if (config.sqliteDriver) setSqliteDriver(config.sqliteDriver);
  if (config.kvDriver) setKVDriver(config.kvDriver);
  if (config.httpClient) setHttpClient(config.httpClient);
  if (config.initialConnectivity) setConnectivityState(config.initialConnectivity);

  engine = new SyncEngine({ transports: [restTransport, localNodeTransport] });
  return { engine };
}

export function getCoreEngine(): SyncEngine {
  if (!engine) throw new Error("TeincFood core not initialised. Call createTeincCore() first.");
  return engine;
}
