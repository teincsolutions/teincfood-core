/**
 * Capabilities reference — offline-first.
 *
 * Standardises business-membership capabilities for both mobile and desktop.
 * The backend `GET /businesses/:id/my-membership` is the source of truth;
 * the result is mirrored to `reference_data` key `capabilities` so drawer/nav
 * filtering works offline and survives restarts.
 *
 * Host apps wire `businessService.fetchMyBusinessMembership` via adapters/services.
 */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openSyncDatabase } from "../db/connection";
import { getReferenceData, setReferenceData } from "./operations";
import { businessService } from "../adapters/services";
import type { BusinessMembershipResponse } from "../types/api/business.api";

const MEMBERSHIP_KEYS = {
  all: ["my-membership"] as const,
  byBusiness: (id: string) => [...MEMBERSHIP_KEYS.all, id] as const,
};

function useCapabilitiesPlaceholder(businessId: string | null | undefined) {
  const [cached, setCached] = useState<BusinessMembershipResponse | null>(null);
  useEffect(() => {
    if (!businessId) {
      setCached(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const db = await openSyncDatabase();
        const rec = await getReferenceData<BusinessMembershipResponse>(db, businessId, "capabilities");
        if (!cancelled && rec?.payload) setCached(rec.payload as unknown as BusinessMembershipResponse);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);
  return cached;
}

/**
 * Standard hook for both apps — businessId comes from the host's active business store.
 * Returns the same shape as the previous app-level useMyBusinessCapabilities.
 */
export function useBusinessCapabilities(businessId?: string | null) {
  const queryClient = useQueryClient();
  void queryClient;
  const cached = useCapabilitiesPlaceholder(businessId ?? null);

  return useQuery({
    queryKey: MEMBERSHIP_KEYS.byBusiness(businessId ?? ""),
    queryFn: async () => {
      const res = (await businessService.fetchMyBusinessMembership(businessId!)) as BusinessMembershipResponse;
      try {
        const db = await openSyncDatabase();
        await setReferenceData(db, businessId!, {
          key: "capabilities",
          version: `membership-${Date.now()}`,
          payload: res,
          downloadedAt: new Date().toISOString(),
        });
      } catch {}
      return res;
    },
    enabled: !!businessId,
    staleTime: Infinity,
    placeholderData: cached ?? undefined,
    select: (data) => ({
      role: (data as BusinessMembershipResponse).data.role,
      source: (data as BusinessMembershipResponse).data.source,
      capabilities: (data as BusinessMembershipResponse).data.capabilities,
      status: (data as BusinessMembershipResponse).data.status,
    }),
  });
}

export function useHasCapabilityFor(businessId: string | undefined, capability: string): boolean {
  const { data } = useBusinessCapabilities(businessId);
  return data?.capabilities.includes(capability) ?? false;
}
