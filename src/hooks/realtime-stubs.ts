/**
 * Realtime invalidation hooks — bridge Phoenix WebSocket events into the
 * Sync Engine so useSyncReconciliation fires and React Query caches refresh.
 *
 * Both hooks are idempotent-safe and can be called from multiple screens.
 * Invalidations are debounced: a reconnect/replay burst can deliver dozens
 * of events at once, and an immediate invalidate-per-event forces repeated
 * full re-renders of boards/grids — a major CPU spike source on low-power
 * POS hardware. Coalescing into one invalidation per ~400ms window keeps
 * the UI fresh without the render storm.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { orderEventsService } from "../realtime/order-events.service";
import { orderSnapshotsService } from "../sync/order-snapshots.service";
import { syncEngine } from "../sync/engine";
import { generateEventId } from "../utils/uuid";
import { getAppInstanceId } from "../adapters/devices";
import type { DomainEvent } from "../sync/types";

const INVALIDATE_DEBOUNCE_MS = 400;

/**
 * Subscribe to real-time order events and invalidate all queries under the
 * given root key prefix (e.g. ['seller'], ['pos'], ['kiosk']).
 *
 * Each event is also persisted to the durable offline read model so order
 * history and states survive a restart while offline, and published through
 * the Sync Engine so useSyncReconciliation + LAN relay fire without polling.
 *
 * Call once per screen that needs live updates (POS, Orders, Kitchen, etc.).
 */
export function useOrderRealtimeUpdates(rootKey: readonly string[]): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pendingOrderIds = new Set<string>();
    const pending = { rootKey: false };
    const ownDeviceId = getAppInstanceId();

    const flush = () => {
      timer = undefined;
      if (pending.rootKey) queryClient.invalidateQueries({ queryKey: rootKey });
      for (const oid of pendingOrderIds) {
        queryClient.invalidateQueries({ queryKey: [...rootKey, "order", oid] });
      }
      pendingOrderIds.clear();
      pending.rootKey = false;
    };

    const unsub = orderEventsService.onOrderUpdates((event) => {
      pending.rootKey = true;
      if (event.order_id) pendingOrderIds.add(event.order_id);

      const payload = { ...event } as Record<string, unknown>;
      const domainEvent: DomainEvent = {
        event_id: (payload.event_id as string) ?? generateEventId(),
        event_type: event.type,
        event_version: (payload.event_version as string) ?? "1.0",
        timestamp: (payload.timestamp as string) ?? new Date().toISOString(),
        device_id: (payload.device_id as string) ?? ownDeviceId,
        user_id: (payload.user_id as string) ?? "system",
        entity_id: event.order_id ?? "",
        payload,
      };

      // Persist to durable offline read model (entity_snapshots table).
      orderSnapshotsService.persistOrderEvent(domainEvent, "cloud").catch(() => {});

      // Publish through the Sync Engine so useSyncReconciliation + LAN relay
      // fire without waiting for the next poll.
      try {
        syncEngine.publish(domainEvent);
      } catch {}

      if (!timer) timer = setTimeout(flush, INVALIDATE_DEBOUNCE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [queryClient, rootKey]);
}

/**
 * Global realtime invalidation — currently handled entirely by
 * useOrderRealtimeUpdates + useSyncReconciliation. Kept as a no-op for
 * backward compatibility with any lingering call sites.
 */
export function useRealtimeInvalidation(): void {}
