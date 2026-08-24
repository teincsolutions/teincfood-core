/**
 * Business store stub.
 */

let activeBusiness: { id: string } | null = null;

export function setActiveBusiness(b: { id: string } | null): void {
  activeBusiness = b;
}

export const useBusinessStore = {
  getState: () => ({ activeBusiness }),
};
