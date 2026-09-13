import { useEffect } from "react";
import { eventsService } from "./events.service";
import { useSyncExternalStore } from "react";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { getAuthToken } from "../adapters/auth";
import { getConnectivityState, subscribeConnectivity } from "../adapters/connectivity";

function useBusinessId(): string | null {
  return useSyncExternalStore(subscribeBusiness, () => getActiveBusiness()?.id ?? null, () => null);
}

function useIsAuthenticated(): boolean {
  // poll auth token presence; host should setAuthProvider — if no provider, assume authenticated when token exists
  return !!getAuthToken();
}

function useIsEffectivelyOnline(): boolean {
  const s = useSyncExternalStore(subscribeConnectivity, getConnectivityState, getConnectivityState);
  return s.isOnline && s.isCloudReachable !== "unreachable";
}

export function useEventsConnection() {
  const activeBusinessId = useBusinessId();
  // derive userId from auth token? Host must provide via setAuthProvider that encodes user, but we need userId for topic.
  // For now, read from global if host set it via setAuthUserId adapter. Fallback: token payload decode.
  // Minimal: require host to call eventsService.connect with userId directly via wrapper — this hook is convenience that reads business only.
  // To keep zero-config, we attempt to read from window localStorage token decode — fallback no-op.
  const userId = deriveUserId();
  // Offline-first: never open the Phoenix socket while the cloud is known
  // unreachable (backend down). Connecting anyway just spins the 1s→10s
  // reconnect loop and spams WS errors. Reconnect fires via effect dep.
  const online = useIsEffectivelyOnline();

  useEffect(() => {
    if (!userId || !online) return;
    const disconnect = eventsService.connect(userId, activeBusinessId);
    return () => disconnect();
  }, [userId, activeBusinessId, online]);
}

function deriveUserId(): string | null {
  try {
    const token = getAuthToken();
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(atob(parts[1]));
    return payload.sub || payload.user_id || payload.id || null;
  } catch { return null; }
}
