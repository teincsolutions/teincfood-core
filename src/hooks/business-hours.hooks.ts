/**
 * Business open/closed hook — reads the offline-first SQLite reference cache.
 * Refetches on a minute cadence so the flag flips at hour boundaries, and on
 * any reference-change invalidation (hours edited locally or background-synced).
 */
import { useQuery } from "@tanstack/react-query";
import { isBusinessOpenNow, type BusinessOpenState } from "../utils/business-hours";

export const BUSINESS_HOURS_KEYS = {
  all: ["business-hours"] as const,
  open: (bid?: string) => [...BUSINESS_HOURS_KEYS.all, "open", bid] as const,
};

export function useBusinessOpenNow(businessId?: string, enabled = true) {
  return useQuery<BusinessOpenState>({
    queryKey: BUSINESS_HOURS_KEYS.open(businessId),
    queryFn: async () => {
      if (!businessId) throw new Error("No business");
      return isBusinessOpenNow(businessId);
    },
    enabled: enabled && !!businessId,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    networkMode: "offlineFirst" as const,
  });
}
