/**
 * @teincfood/core — shared offline-first backbone
 *
 * Entry point. Re-exports types, sync engine, DB, reference service, repos and adapters.
 * Host apps call `createTeincCore` once at bootstrap to wire platform adapters.
 */

// ── Types ──
export * from "./types/api";
export * from "./types/pos.types";
export * from "./types/rider";
export * from "./types/places";
export * from "./adapters/notify";

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
export * from "./utils/debug-log";
export * from "./utils/attempt-stats";
export { PHONE_COUNTRIES, getDialCodeFromCountry, getCountryOption, normalizePhoneForCountry, isLikelyE164 } from "./utils/phone";
export type { PhoneCountryOption } from "./utils/phone";
export * from "./utils/formatCurrency";
export { formatDate, formatRelativeTime } from "./utils/formatDate";
export * from "./utils/validation";
export * from "./validation/offline";
export * from "./utils/copyToClipBoard";
export * from "./utils/customer-display";
export * from "./utils/order-filter";
export { useReferenceData } from "./reference/hooks";
export { setNotifyHandlers } from "./adapters/notify";
export { walletService, riderService, fleetService, deliveryService, dashboardService, analyticsService, placesService } from "./adapters/services";
export { buildMenuItemEnvelope, buildMenuCategoryEnvelope } from "./reference/menu-record";
export { validateMenuItemInput, validateMenuCategoryInput, validateOrderCreateInput, validateInviteInput } from "./validation/offline";
export { useBusinessDeliveriesQuery } from "./hooks/delivery.hooks";
export { useBusinessReferenceDataSync } from "./reference/hooks";
export { createAppQueryClient, createQueryPersister } from "./providers/query-client";
export { useSellerAnalyticsQuery } from "./hooks/analytics.hooks";
export { useSellerDashboardQuery } from "./hooks/dashboard.hooks";
export { useRealtimeInvalidation, useOrderRealtimeUpdates } from "./hooks/realtime-stubs";
export {
  useAcceptFleetInvitationMutation,
  useAcceptBusinessInvitationMutation,
  useUserInvitationsQuery,
} from "./hooks/members.hooks";
export { useJoinRequestsQuery } from "./hooks/fleet.hooks";

// ── DB ──
export * from "./db/migrations";
export * from "./db/operations";
export * as dbOps from "./db/operations";
export { openSyncDatabase, getSyncDatabase, closeSyncDatabase } from "./db/connection";

// ── Sync ──
export * from "./sync/types";
export * from "./sync/online-gates";
export * from "./sync/use-sync-reconciliation";
export { SyncEngine, syncEngine } from "./sync/engine";
export * from "./sync/command-builder";
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
export * from "./hooks/use-infinite-list";
export * from "./hooks/wallet.hooks";
export * from "./hooks/rider.hooks";
export * from "./hooks/fleet.hooks";
export * from "./hooks/delivery.hooks";
export * from "./hooks/dashboard.hooks";
export * from "./hooks/analytics.hooks";
export * from "./hooks/members.hooks";
export * from "./hooks/places.hooks";
export * from "./hooks/offline-orders.hooks";
export * from "./hooks/image.hooks";
export * from "./hooks/realtime-stubs";
export * from "./providers/query-client";
export {
  KIOSK_KEYS,
  useKioskOrdersQuery,
  useAvailableRidersQuery,
  type AvailableRider,
  useAcceptKioskOrderMutation,
  useRejectKioskOrderMutation,
  useStartPreparingKioskOrderMutation,
  useMarkKioskOrderReadyMutation,
} from "./hooks/kiosk.hooks";

// ── Reference ──
export * from "./reference/types";
export * from "./reference/operations";
export { fetchReferenceVersions, fetchReferenceData, fetchReferenceChanges, setReferenceLocalNodeFetcher, setReferenceData, mergeReferenceData, setOperatingHoursLocal, setBusinessProfileLocal } from "./reference/api";
export type { ReferenceLocalNodeFetcher } from "./reference/api";
export { emitReferenceChanged, applyReferenceChangeEvent, syncReferenceDataOnReconnect, registerReferenceEventEngine, registerReferenceInvalidator } from "./reference/events";
export * from "./reference/events";
export * from "./reference/service";
export * from "./reference/hooks";
export { referenceSyncService } from "./reference/service";
export * from "./reference/menu-record";
export * from "./reference/menu-apply";
export * from "./reference/capabilities";

// ── Adapters (for host apps to supply) ──
export * from "./adapters/sqlite";
export { KVDriver, setKVDriver, getKVDriver, kvGetItem, kvSetItem, kvRemoveItem, getItem, setItem, removeItem, getItemSync, setItemSync } from "./adapters/kv";
export * from "./adapters/connectivity";
export * from "./adapters/http";
export * from "./local-node/types";
export * from "./local-node/store";
export * from "./local-node/security";
export * from "./local-node/adapters";
export * from "./local-node/service";
// adapters/local-node is compat shim — export only non-conflicting
export { setLocalNodeState } from "./adapters/local-node";
export * from "./adapters/services";
export * from "./adapters/devices";
export { setAuthProvider, getAuthToken, setAuthRefreshProvider, getRefreshToken, setAuthTokensProvider, setAuthTokens, setAuthClearProvider, clearAuth } from "./adapters/auth";
export { imageCacheService } from "./adapters/image-cache";
export * from "./adapters/business";
export * from "./adapters/pending-orders";
export * from "./adapters/print";
export * from "./adapters/filesystem";
export { SELLER_ORDERS_KEYS, BUSINESS_DELIVERIES_KEYS, MENU_KEYS, REFERENCE_KEYS } from "./adapters/query-keys";
// KIOSK_KEYS exported from hooks/kiosk.hooks (single source)
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

// ── Order transitions (shared business logic — single source) ──
export * from "./utils/order-transitions";

// ── Business hours gate (single source — mirrors backend is_open?) ──
export * from "./utils/business-hours";
export * from "./hooks/business-hours.hooks";
// components/OrderStatusCard was folded into order-transitions (compat re-export lives in apps)

// ── Domain (offline-first primary DB) ──
export * from "./domain/orders/service";

// ── Realtime (single source — PHX WebSocket + business:{id}) ──
export { phoenixSocket } from "./realtime/phoenix-socket";
export { eventsService } from "./realtime/events.service";
export { orderEventsService } from "./realtime/order-events.service";
export { useEventsConnection } from "./realtime/useEventsConnection";

// ── Sync jobs (POS primary sync) — debug helpers for DiagnosticsScreen
export { getSyncJobsPendingCount, debugDumpSyncJobs, drainPending } from "./sync/sync-jobs.service";
export { performFullSync } from "./sync/full-sync";
export { stopHealthProbe } from "./sync/health-probe";
export { notifyAuthChanged, subscribeAuth } from "./adapters/auth";
// ── Session lifecycle (access-expired → refresh → refresh-expired → logout)
export {
  ACCESS_EXPIRED_CODE,
  SESSION_DEAD_CODES,
  SKIP_AUTH_RETRY,
  extractAuthFailure,
  isAccessExpired,
  isSessionDead,
  hasAuthRetrySkip,
  refreshSession,
  withAuthRetry,
} from "./auth/session";
export type { AuthFailure, SessionTokens } from "./auth/session";

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
import { setupSyncJobsDrain } from "./sync/sync-jobs.service";
import { startHealthProbe, stopHealthProbe } from "./sync/health-probe";

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

  try { setupSyncJobsDrain(); } catch {}
  try { startHealthProbe(); } catch {}

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
