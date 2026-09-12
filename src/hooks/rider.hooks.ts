/**
 * Rider hooks — single source for both apps (previously verbatim copies).
 * Reads serve cache instantly; network refreshes silently when online.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { riderService } from "../adapters/services";
import { notifySuccess, notifyError } from "../adapters/notify";
import { assertOnlineFor } from "../sync/online-gates";
import { extractApiErrorMessage } from "../utils/error";
import { useInfiniteList } from "./use-infinite-list";
import type { RiderDelivery } from "../types/api/rider.api";
import type { DeliveryZone, NavigationSettings } from "../types/rider";

// Query keys
export const RIDER_KEYS = {
  all: ["rider"] as const,
  profile: () => [...RIDER_KEYS.all, "profile"] as const,
  metrics: () => [...RIDER_KEYS.all, "metrics"] as const,
  activeDelivery: () => [...RIDER_KEYS.all, "active-delivery"] as const,
  deliveries: () => [...RIDER_KEYS.all, "deliveries"] as const,
  deliveryDetail: (id: string) => [...RIDER_KEYS.all, "delivery", id] as const,
  earnings: () => [...RIDER_KEYS.all, "earnings"] as const,
  earningsBreakdown: () => [...RIDER_KEYS.all, "earnings-breakdown"] as const,
  earningsSummary: (period: string) => [...RIDER_KEYS.all, "earnings-summary", period] as const,
  transactions: () => [...RIDER_KEYS.all, "transactions"] as const,
  statistics: () => [...RIDER_KEYS.all, "statistics"] as const,
  vehicleInfo: () => [...RIDER_KEYS.all, "vehicle"] as const,
  deliveryZones: () => [...RIDER_KEYS.all, "zones"] as const,
  navigationSettings: () => [...RIDER_KEYS.all, "navigation"] as const,
  navigationApps: () => [...RIDER_KEYS.all, "navigation-apps"] as const,
};

// ─── Available Orders ───

export function useAvailableOrdersQuery(enabled = true) {
  return useQuery({
    queryKey: [...RIDER_KEYS.all, "available-orders"],
    queryFn: async () => {
      const res = (await riderService.fetchAvailableOrders()) as { data: unknown };
      return res.data;
    },
    enabled,
    staleTime: 15000,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

export function useClaimOrderMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => riderService.acceptDelivery(orderId),
    onSuccess: () => {
      notifySuccess("Interest claimed! You'll be notified when ready.");
      queryClient.invalidateQueries({ queryKey: [...RIDER_KEYS.all, "available-orders"] });
    },
    onError: (error) => {
      notifyError(extractApiErrorMessage(error as Error));
    },
  });
}

export function useSelfAssignMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => riderService.selfAssignDelivery(orderId),
    onSuccess: () => {
      notifySuccess("Delivery assigned! Confirm handover with the restaurant.");
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.deliveries() });
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.activeDelivery() });
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.metrics() });
    },
    onError: (error) => {
      notifyError(extractApiErrorMessage(error as Error));
    },
  });
}

// ─── Metrics & Dashboard Hooks ───

export function useRiderProfileQuery(enabled = true) {
  return useQuery({
    queryKey: RIDER_KEYS.profile(),
    queryFn: async () => {
      const res = (await riderService.fetchRiderProfile()) as { data: unknown };
      return res.data;
    },
    enabled,
    staleTime: 30000,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

export function useRiderMetricsQuery(enabled = true) {
  return useQuery({
    queryKey: RIDER_KEYS.metrics(),
    queryFn: async () => {
      const res = (await riderService.fetchRiderDashboard()) as { data: unknown };
      return res.data;
    },
    enabled,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

export function useActiveDeliveryQuery(enabled = true) {
  return useQuery({
    queryKey: RIDER_KEYS.activeDelivery(),
    queryFn: async () => {
      const res = (await riderService.fetchActiveDelivery()) as { data: unknown };
      return res.data;
    },
    enabled,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

// ─── Deliveries Hooks ───

export function useRiderDeliveriesQuery(
  enabled = true,
  filters?: { q?: string; status?: string; order_number?: string; date_from?: string; date_to?: string },
) {
  return useInfiniteList<RiderDelivery>({
    key: [...RIDER_KEYS.deliveries(), filters],
    enabled,
    pageSize: 20,
    onlineFetch: async (page, pageSize) => {
      const res = (await riderService.fetchRiderDeliveries(page, pageSize, filters as Record<string, unknown>)) as {
        data: RiderDelivery[];
        pagination: { page: number; page_size: number; total_pages: number; total_entries?: number };
      };
      return res;
    },
  });
}

export function useRiderDeliveryDetailQuery(deliveryId: string, enabled = true) {
  return useQuery({
    queryKey: RIDER_KEYS.deliveryDetail(deliveryId),
    queryFn: () => riderService.fetchDeliveryDetail(deliveryId),
    enabled: enabled && Boolean(deliveryId),
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

export function useUpdateDeliveryStatusMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ deliveryId, action }: { deliveryId: string; action: string }) => {
      // Delivery state transitions require online (single source).
      assertOnlineFor("order:create", { order_type: "delivery" });
      const actions: Record<string, (id: string) => Promise<unknown>> = {
        "in-transit": riderService.markDeliveryInTransit,
        arrived: riderService.markDeliveryArrived,
        delivered: riderService.markDeliveryDelivered,
        failed: riderService.markDeliveryFailed,
        returned: riderService.markDeliveryReturned,
        "confirm-pickup": riderService.confirmDeliveryPickup,
        "confirm-handover": riderService.confirmDeliveryHandover,
      };
      const fn = actions[action];
      if (!fn) return Promise.reject(new Error(`Unknown action: ${action}`));
      return fn(deliveryId);
    },
    onSuccess: (_, { deliveryId }) => {
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.deliveries() });
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.deliveryDetail(deliveryId) });
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.activeDelivery() });
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.metrics() });
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.earnings() });
    },
  });
}

export function useAcceptDeliveryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => riderService.selfAssignDelivery(orderId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...RIDER_KEYS.all, "available-orders"] });
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.deliveries() });
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.activeDelivery() });
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.metrics() });
    },
  });
}

// ─── Earnings Hooks ───

export function useRiderEarningsQuery(enabled = true) {
  return useQuery({
    queryKey: RIDER_KEYS.earnings(),
    queryFn: () => riderService.fetchRiderEarnings(),
    enabled,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

export function useEarningsBreakdownQuery(enabled = true) {
  return useQuery({
    queryKey: RIDER_KEYS.earningsBreakdown(),
    queryFn: () => riderService.fetchEarningsBreakdown(),
    enabled,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

export function useRiderEarningsSummaryQuery(period: "today" | "this_week" | "this_month", enabled = true) {
  return useQuery({
    queryKey: RIDER_KEYS.earningsSummary(period),
    queryFn: () => riderService.fetchRiderEarningsSummary(period),
    enabled,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

export function useRiderWalletHistoryQuery(enabled = true) {
  return useInfiniteList<Record<string, unknown>>({
    key: RIDER_KEYS.transactions(),
    enabled,
    pageSize: 20,
    onlineFetch: async (page, pageSize) => {
      const res = (await riderService.fetchWalletHistory(page, pageSize)) as {
        data: { entries: Record<string, unknown>[] };
        pagination: { page: number; page_size: number; total_pages: number; total_entries?: number };
      };
      return { data: res.data.entries, pagination: res.pagination };
    },
  });
}

export function useRequestPayoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (_amount: number) => Promise.reject(new Error("Payout not implemented on backend")),
    onError: () => {},
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.earnings() });
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.transactions() });
    },
  });
}

// ─── Statistics Hooks ───

export function useRiderStatisticsQuery(enabled = true) {
  return useQuery({
    queryKey: RIDER_KEYS.statistics(),
    queryFn: () => riderService.fetchRiderStatistics(),
    enabled,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

// ─── Vehicle Info Hooks ───

export function useVehicleInfoQuery(enabled = true) {
  return useQuery({
    queryKey: RIDER_KEYS.vehicleInfo(),
    queryFn: () => riderService.fetchVehicleInfo(),
    enabled,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

export function useCreateVehicleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vehicleInfo: unknown) => riderService.createVehicle(vehicleInfo),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.vehicleInfo() });
    },
    onError: (error) => {
      try {
        console.debug("[useCreateVehicleMutation] error", error);
      } catch {}
    },
  });
}

// ─── Delivery Zones Hooks ───

export function useDeliveryZonesQuery(enabled = true) {
  return useQuery({
    queryKey: RIDER_KEYS.deliveryZones(),
    queryFn: () => riderService.fetchDeliveryZones(),
    enabled,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

export function useUpdateDeliveryZonesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (zones: DeliveryZone[]) => riderService.updateDeliveryZones(zones),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.deliveryZones() });
    },
  });
}

export function useToggleDeliveryZoneMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ zoneId, enabled }: { zoneId: string; enabled: boolean }) => riderService.toggleDeliveryZone(zoneId, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.deliveryZones() });
    },
  });
}

// ─── Navigation Settings Hooks ───

export function useNavigationSettingsQuery(enabled = true) {
  return useQuery({
    queryKey: RIDER_KEYS.navigationSettings(),
    queryFn: () => riderService.fetchNavigationSettings(),
    enabled,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

export function useUpdateNavigationSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: Partial<NavigationSettings>) => riderService.updateNavigationSettings(settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.navigationSettings() });
    },
  });
}

// ─── Online Status Hooks ───

export function useUpdateOnlineStatusMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (isOnline: boolean) => riderService.updateOnlineStatus(isOnline),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.profile() });
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.metrics() });
    },
    onError: (error) => {
      try {
        console.debug("[useUpdateOnlineStatus] error", error);
      } catch {}
      notifyError(extractApiErrorMessage(error as Error));
    },
  });
}

// ─── Navigation Apps Hooks ───

export function useNavigationAppsQuery(enabled = true) {
  return useQuery({
    queryKey: RIDER_KEYS.navigationApps(),
    queryFn: () => riderService.fetchNavigationApps(),
    enabled,
    staleTime: Infinity,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

// ─── Vehicle Types Hooks ───

export function useVehicleTypesQuery(enabled = true) {
  return useQuery({
    queryKey: [...RIDER_KEYS.all, "vehicle-types"],
    queryFn: () => riderService.fetchVehicleTypes(),
    enabled,
    staleTime: Infinity,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

// ─── Toggle Online Status ───

export function useToggleOnlineMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (isOnline: boolean) => riderService.updateRiderProfile({ is_online: isOnline }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: RIDER_KEYS.profile() });
    },
  });
}
