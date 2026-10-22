/**
 * Realtime invalidation hooks.
 *
 * The cloud → local event path now has a single owner: the global realtime
 * bridge (`src/realtime/realtime-bridge.ts`), mounted once per app. It
 * publishes every cloud event through the Sync Engine, and
 * `useSyncReconciliation` reacts by journaling the event, patching the
 * offline read model, invalidating the affected caches (debounced, 400 ms)
 * and relaying the event to LAN peers.
 *
 * `useOrderRealtimeUpdates` used to be mounted per screen (POS, Orders,
 * Kitchen, Display). That meant every mounted screen processed the same
 * event — duplicated persistence, duplicated invalidations, duplicated
 * fetches — and every screen that did NOT mount it (Dashboard, Settings)
 * never saw another terminal's order at all. It is kept as a no-op so
 * existing call sites keep compiling; new code must not use it.
 *
 * Invalidations stay coalesced: a reconnect/replay burst can deliver dozens
 * of events at once, and an immediate invalidate-per-event forces repeated
 * full re-renders of boards/grids — a major CPU spike on low-power POS
 * hardware. One invalidation per ~400 ms window keeps the UI fresh without
 * the render storm.
 */

import { useGlobalRealtimeBridge } from "../realtime/realtime-bridge";

/**
 * @deprecated Mount the global bridge once at the app root instead
 * (`useRealtimeInvalidation` or `useSyncReconciliation`). Kept as a no-op
 * so legacy call sites remain source-compatible.
 */
export function useOrderRealtimeUpdates(_rootKey: readonly string[]): void {}

/**
 * Global realtime invalidation — mounts the single app-wide Phoenix
 * subscription. Pair with `useSyncReconciliation` (which reacts to the
 * published events) at the app root.
 */
export function useRealtimeInvalidation(): void {
  useGlobalRealtimeBridge();
}
