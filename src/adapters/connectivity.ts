/**
 * Connectivity adapter — replaces zustand connectivity store.
 * Host apps inject real connectivity state; core defaults to offline-unknown.
 */

export type CloudReachable = "reachable" | "unreachable" | "unknown";

export interface ConnectivityState {
  isOnline: boolean;
  isCloudReachable: CloudReachable;
}

let state: ConnectivityState = {
  isOnline: true,
  isCloudReachable: "unknown",
};

const listeners = new Set<() => void>();

export function getConnectivityState(): ConnectivityState {
  return state;
}

export function setConnectivityState(patch: Partial<ConnectivityState>): void {
  const next = { ...state, ...patch };
  if (next.isOnline === state.isOnline && next.isCloudReachable === state.isCloudReachable) return;
  state = next;
  listeners.forEach((l) => l());
}

export function setCloudReachable(value: CloudReachable): void {
  setConnectivityState({ isCloudReachable: value });
}

export function setOnline(value: boolean): void {
  setConnectivityState({ isOnline: value });
}

export function subscribeConnectivity(listener: () => void): () => void {
  listeners.add(listener as () => void);
  return () => listeners.delete(listener as () => void);
}

// Compatibility shim for code that previously used useConnectivityStore.getState()
export const connectivityStoreShim = {
  getState: getConnectivityState,
};
