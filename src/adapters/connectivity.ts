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

const listeners = new Set<(s: ConnectivityState) => void>();

export function getConnectivityState(): ConnectivityState {
  return { ...state };
}

export function setConnectivityState(patch: Partial<ConnectivityState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l({ ...state }));
}

export function setCloudReachable(value: CloudReachable): void {
  setConnectivityState({ isCloudReachable: value });
}

export function setOnline(value: boolean): void {
  setConnectivityState({ isOnline: value });
}

export function subscribeConnectivity(
  listener: (s: ConnectivityState) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Compatibility shim for code that previously used useConnectivityStore.getState()
export const connectivityStoreShim = {
  getState: getConnectivityState,
};
