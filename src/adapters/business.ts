/**
 * Business store adapter — host app injects active business; core hooks subscribe.
 */

let activeBusiness: { id: string } | null = null;

const listeners = new Set<(b: { id: string } | null) => void>();

export function setActiveBusiness(b: { id: string } | null): void {
  activeBusiness = b;
  listeners.forEach((l) => l(b));
}

export function getActiveBusiness(): { id: string } | null {
  return activeBusiness;
}

export function subscribeBusiness(listener: (b: { id: string } | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useBusinessStore = {
  getState: () => ({ activeBusiness }),
  subscribe: subscribeBusiness,
};
