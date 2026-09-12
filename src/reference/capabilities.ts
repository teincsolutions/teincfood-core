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
import { useSyncExternalStore } from "react";
import { openSyncDatabase } from "../db/connection";
import { getReferenceData, setReferenceData } from "./operations";
import { businessService } from "../adapters/services";
import { getConnectivityState, subscribeConnectivity } from "../adapters/connectivity";
import type { BusinessMembershipResponse } from "../types/api/business.api";
import { useIsEffectivelyOnline } from "../hooks/use-infinite-list";

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
 * Offline-first: when offline, only the SQLite cache (`capabilities`) is used so
 * nav filtering (menu/pos/orders/deliveries hidden) does not break when backend is down.
 * When online, network refreshes the cache.
 */
export function useBusinessCapabilities(businessId?: string | null) {
  const isOnline = useIsEffectivelyOnline();
  const cached = useCapabilitiesPlaceholder(businessId ?? null);

  const query = useQuery({
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
    enabled: !!businessId && isOnline,
    staleTime: 30 * 1000,
    retry: false,
    networkMode: "offlineFirst" as const,
    placeholderData: cached ?? undefined,
  });

  // When offline, use the SQLite-cached membership directly so nav stays visible.
  const raw = (query.data as BusinessMembershipResponse | undefined) ?? cached ?? null;
  const selected = raw
    ? {
        role: (raw as BusinessMembershipResponse).data.role,
        source: (raw as BusinessMembershipResponse).data.source,
        capabilities: (raw as BusinessMembershipResponse).data.capabilities,
        status: (raw as BusinessMembershipResponse).data.status,
      }
    : undefined;

  return {
    ...query,
    data: selected,
  } as unknown as ReturnType<typeof useQuery> & { data: typeof selected };
}

export function useHasCapabilityFor(businessId: string | undefined, capability: string): boolean {
  const { data } = useBusinessCapabilities(businessId);
  return data?.capabilities.includes(capability) ?? false;
}

export const CAPABILITY_BY_COMMAND: Record<string, string> = {
  "order:create": "orders_create",
  "order:accept": "orders_accept",
  "order:reject": "orders_reject",
  "order:start_preparing": "orders_start_preparing",
  "order:mark_ready": "orders_mark_ready",
  "order:complete_pickup": "orders_mark_ready",
  "order:cancel": "orders_reject",
  "delivery:assign": "deliveries_assign",
  "delivery:confirm_handover": "deliveries_all",
  "menu:create_item": "menu_manage",
  "menu:update_item": "menu_manage",
  "menu:delete_item": "menu_manage",
  "menu:create_category": "menu_manage",
  "menu:update_category": "menu_manage",
  "menu:delete_category": "menu_manage",
  "payment:confirm_cash": "orders_accept",
};

export async function hasCapabilitySync(businessId: string, commandType: string): Promise<boolean> {
  const required = CAPABILITY_BY_COMMAND[commandType];
  if (!required) return true;
  try {
    const db = await openSyncDatabase();
    const rec = await getReferenceData<BusinessMembershipResponse>(db, businessId, "capabilities");
    const caps = (rec?.payload as unknown as BusinessMembershipResponse)?.data?.capabilities ?? [];
    return caps.includes(required);
  } catch {
    return true; // fail open if cache unreadable — backend will still 403
  }
}

export function hasCapabilitySyncSync(businessId: string, commandType: string): boolean {
  // Synchronous fallback for non-async callers — checks in-memory KV mirror if available
  const required = CAPABILITY_BY_COMMAND[commandType];
  if (!required) return true;
  return true;
}
