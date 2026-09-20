/**
 * Business open/closed hook — reads the offline-first SQLite reference cache.
 * Refetches on a minute cadence so the flag flips at hour boundaries, and on
 * any reference-change invalidation (hours edited locally or background-synced).
 */
import { useQuery } from "@tanstack/react-query";
import { isBusinessOpenNow, type BusinessOpenState, type OrderChannel } from "../utils/business-hours";
import { getReferenceData } from "../reference/operations";
import { openSyncDatabase } from "../db/connection";
import type { OperatingHoursEntry } from "../types/api/business.api";

export const BUSINESS_HOURS_KEYS = {
  all: ["business-hours"] as const,
  open: (bid?: string) => [...BUSINESS_HOURS_KEYS.all, "open", bid] as const,
};

export function useBusinessOpenNow(businessId?: string, enabled = true, channel: OrderChannel = "online") {
  return useQuery<BusinessOpenState>({
    queryKey: [...BUSINESS_HOURS_KEYS.open(businessId), channel],
    queryFn: async () => {
      if (!businessId) throw new Error("No business");
      return isBusinessOpenNow(businessId, new Date(), channel);
    },
    enabled: enabled && !!businessId,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    networkMode: "offlineFirst" as const,
  });
}

export function useOperatingHours(businessId?: string, enabled = true) {
  return useQuery<OperatingHoursEntry[]>({
    queryKey: BUSINESS_HOURS_KEYS.open(businessId).concat(["entries"]),
    queryFn: async () => {
      if (!businessId) throw new Error("No business");
      const db = await openSyncDatabase();
      const rec = await getReferenceData<unknown>(db, businessId, "operating-hours");
      if (!rec) return [];
      const payload = rec.payload as { data?: OperatingHoursEntry[] } | OperatingHoursEntry[];
      return Array.isArray(payload) ? payload : (payload.data ?? []);
    },
    enabled: enabled && !!businessId,
    staleTime: 30 * 1000,
    networkMode: "offlineFirst" as const,
  });
}
