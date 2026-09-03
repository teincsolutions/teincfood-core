/**
 * Business store adapter — host app injects active business; core hooks subscribe.
 */

let activeBusiness: { id: string } | null = null;

const listeners = new Set<() => void>();

export function setActiveBusiness(b: { id: string } | null): void {
  if ((b?.id ?? null) === (activeBusiness?.id ?? null)) return;
  activeBusiness = b;
  listeners.forEach((l) => l());
}

export function getActiveBusiness(): { id: string } | null {
  return activeBusiness;
}

export function subscribeBusiness(listener: () => void): () => void {
  listeners.add(listener as () => void);
  return () => listeners.delete(listener as () => void);
}

export const useBusinessStore = {
  getState: () => ({ activeBusiness }),
  subscribe: subscribeBusiness,
};
