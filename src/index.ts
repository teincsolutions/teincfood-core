/**
 * @teincfood/core — shared offline-first backbone
 *
 * Entry point. Re-exports types, sync engine, DB, reference service, repos and adapters.
 * Host apps call `createTeincCore` once at bootstrap to wire platform adapters.
 */

// ── Types ──
export * from "./types/api";
export * from "./types/pos.types";

// ── Pricing (server-parity) ──
export {
  calculatePricing,
  calculateTaxLines,
  calculateExclusiveTax,
  calculateInclusiveTaxShare,
} from "./pricing/engine";
export type { PricingInput, PricingResult } from "./pricing/engine";

// ── Utils ──
export * from "./utils/constants";
export * from "./utils/currency";
export * from "./utils/error";
export * from "./utils/uuid";
export * from "./utils/sync-logger";
export { PHONE_COUNTRIES, getDialCodeFromCountry, getCountryOption, normalizePhoneForCountry, isLikelyE164 } from "./utils/phone";
export type { PhoneCountryOption } from "./utils/phone";
export * from "./utils/formatCurrency";
export { formatDate, formatRelativeTime } from "./utils/formatDate";
export * from "./utils/validation";
export * from "./utils/responsive";
export * from "./utils/copyToClipBoard";
export * from "./utils/customer-display";
export * from "./utils/order-filter";

// ── DB ──
export * from "./db/migrations";
export * from "./db/operations";
export * as dbOps from "./db/operations";
export { openSyncDatabase, getSyncDatabase, closeSyncDatabase } from "./db/connection";

// ── Sync ──
export * from "./sync/types";
export * from "./sync/use-sync-reconciliation";
export { SyncEngine, syncEngine } from "./sync/engine";
export * from "./sync/command-builder";
export * from "./sync/command-queue.service";
export { commandQueueService } from "./sync/command-queue.service";
export { buildCommand } from "./sync/command-builder";
export {
  generateLocalOrderNumber,
  generateLocalCalloutNumber,
  isLocalOrderNumber,
  generateOrderNumber,
  generateOrderNumberForBusiness,
  isOfflineOrderNumber,
  parseOrderNumber,
  resetCalloutForTests,
} from "./sync/order-number";
export { deviceLeaseService, getDeviceNumber, isOnlineOnly, ensureLease } from "./sync/device-lease.service";
export { useDeviceLease, ensureDeviceLease } from "./sync/use-device-lease";
export * from "./utils/hlc";
export * from "./reference/lww";
export { orderSnapshotsService } from "./sync/order-snapshots.service";
export * from "./sync/pending-orders.service";
export { restTransport } from "./sync/transport-rest";
export * from "./sync/transport-rest";
export { localNodeTransport } from "./sync/transport-local-node";
export * from "./sync/transport-local-node";
export * from "./sync/order-snapshots.service";
export { hydratePendingOrders, applyPendingOrderEvent, applyOrderStateChangeEvent } from "./sync/pending-orders.service";
export { runOfflineCapableMutation } from "./sync/offline-capable";
export type { OfflineCapableOptions } from "./sync/offline-capable";

// ── Repositories ──
export { orderRepository } from "./repositories/order.repository";
export type { CreateOrderInput, AssignRiderInput, OrderActionInput } from "./repositories/order.repository";
export { posRepository } from "./repositories/pos.repository";
export type { POSOrderPreviewInput } from "./repositories/pos.repository";

// ── Order lifecycle hooks (offline-first, device-owned outbox) ──
export * from "./hooks/orders.hooks";

// ── Reference ──
export * from "./reference/types";
export * from "./reference/operations";
export { fetchReferenceVersions, fetchReferenceData, fetchReferenceChanges, setReferenceLocalNodeFetcher } from "./reference/api";
export type { ReferenceLocalNodeFetcher } from "./reference/api";
export { emitReferenceChanged, applyReferenceChangeEvent, syncReferenceDataOnReconnect, registerReferenceEventEngine, registerReferenceInvalidator } from "./reference/events";
export * from "./reference/events";
export * from "./reference/service";
export { referenceSyncService } from "./reference/service";
export * from "./reference/capabilities";

// ── Adapters (for host apps to supply) ──
export * from "./adapters/sqlite";
export { KVDriver, setKVDriver, getKVDriver, kvGetItem, kvSetItem, kvRemoveItem, getItem, setItem, removeItem, getItemSync, setItemSync } from "./adapters/kv";
export * from "./adapters/connectivity";
export * from "./adapters/http";
export * from "./adapters/local-node";
export * from "./adapters/services";
export * from "./adapters/devices";
export { imageCacheService } from "./adapters/image-cache";
export * from "./adapters/business";
export * from "./adapters/pending-orders";
export * from "./adapters/print";
export * from "./adapters/filesystem";
export { KIOSK_KEYS, SELLER_ORDERS_KEYS, BUSINESS_DELIVERIES_KEYS, MENU_KEYS, REFERENCE_KEYS } from "./adapters/query-keys";
// POS_KEYS / SELLER_KEYS are exported from hooks/orders.hooks (offline-first source of truth)

// ── Printer (backend-identical template) ──
export * from "./printer/types";
export * from "./printer/store";
export * from "./printer/receipt";
export * from "./printer/service";
export * from "./printer/hooks";

// ── Cart (device-local) ──
export * from "./cart/store";
export * from "./cart/hooks";

// ── Catalog ──
export * from "./catalog/hooks";

// ── Image cache (durable) ──
export { getCachedImagePath, ensureImageCacheDir, getCachedImageInfo, cacheRemoteImage, cacheImageBatch, clearImageCache, pruneImageCache, resolveImageSource, stableCacheUrl } from "./image-cache/service";

// ── Init helper ──
import { setSqliteDriver, type SqliteDriver } from "./adapters/sqlite";
import { setKVDriver, type KVDriver } from "./adapters/kv";
import { setConnectivityState } from "./adapters/connectivity";
import { setHttpClient, type HttpClient } from "./adapters/http";
import { setTcpAdapter, setPrintFileAdapter, setMdnsAdapter } from "./adapters/print";
import { setFileSystemAdapter } from "./adapters/filesystem";
import { API_BASE_URL, WS_BASE_URL, setApiBaseUrl, setWsBaseUrl } from "./utils/constants";
import { SyncEngine } from "./sync/engine";
import { restTransport } from "./sync/transport-rest";
import { localNodeTransport } from "./sync/transport-local-node";

export interface CoreConfig {
  sqliteDriver?: SqliteDriver;
  kvDriver?: KVDriver;
  httpClient?: HttpClient;
  apiBaseUrl?: string;
  wsBaseUrl?: string;
  /** Optional initial connectivity override */
  initialConnectivity?: { isOnline?: boolean; isCloudReachable?: "reachable" | "unreachable" | "unknown" };
  printAdapters?: { tcp?: import("./adapters/print").TcpSocketAdapter; printFile?: import("./adapters/print").PrintFileAdapter; mdns?: import("./adapters/print").MdnsAdapter };
  fileSystemAdapter?: import("./adapters/filesystem").FileSystemAdapter;
}

let engine: SyncEngine | null = null;

export function createTeincCore(config: CoreConfig = {}): { engine: SyncEngine } {
  try {
    console.debug("[core] createTeincCore called", {
      hasSqliteDriver: !!config.sqliteDriver,
      hasKvDriver: !!config.kvDriver,
      hasHttpClient: !!config.httpClient,
      apiBaseUrl: config.apiBaseUrl ?? "(default)",
      wsBaseUrl: config.wsBaseUrl ?? "(default)",
      initialConnectivity: config.initialConnectivity ?? null,
    });
  } catch {}
  if (config.sqliteDriver) setSqliteDriver(config.sqliteDriver);
  if (config.kvDriver) setKVDriver(config.kvDriver);
  if (config.httpClient) setHttpClient(config.httpClient);
  if (config.printAdapters?.tcp) setTcpAdapter(config.printAdapters.tcp);
  if (config.printAdapters?.printFile) setPrintFileAdapter(config.printAdapters.printFile);
  if (config.printAdapters?.mdns) setMdnsAdapter(config.printAdapters.mdns);
  if (config.fileSystemAdapter) setFileSystemAdapter(config.fileSystemAdapter);
  if (config.apiBaseUrl) setApiBaseUrl(config.apiBaseUrl);
  else {
    try { console.debug("[core] apiBaseUrl not provided by app, using default", API_BASE_URL); } catch {}
  }
  if (config.wsBaseUrl) setWsBaseUrl(config.wsBaseUrl);
  else {
    try { console.debug("[core] wsBaseUrl not provided by app, using default", WS_BASE_URL); } catch {}
  }
  if (config.initialConnectivity) setConnectivityState(config.initialConnectivity);

  // Debug: confirm env vars as seen by core after injection
  try {
    console.debug("[core] final URLs", { API_BASE_URL, WS_BASE_URL });
  } catch {}

  engine = new SyncEngine({ transports: [restTransport, localNodeTransport] });
  return { engine };
}

export function getCoreEngine(): SyncEngine {
  if (!engine) throw new Error("TeincFood core not initialised. Call createTeincCore() first.");
  return engine;
}
