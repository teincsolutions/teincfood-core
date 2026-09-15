/**
 * Fleet hooks — single source for both apps (previously verbatim copies).
 * Reads serve cache instantly; network refreshes silently when online.
 * Member/fleet management mutations require online (single source gates).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { getAuthToken, subscribeAuth } from "../adapters/auth";
import { fleetService } from "../adapters/services";
import { assertOnlineFor } from "../sync/online-gates";
import { validateInviteInput } from "../validation/offline";
import { useIsEffectivelyOnline } from "./use-infinite-list";
import type { FleetVehicle } from "../types/api/fleet.api";

export const FLEET_KEYS = {
  all: ["fleet"] as const,
  riders: (businessId?: string) => [...FLEET_KEYS.all, "riders", businessId] as const,
  riderDetail: (id: string) => [...FLEET_KEYS.all, "rider", id] as const,
  riderKyc: (id: string) => [...FLEET_KEYS.all, "rider-kyc", id] as const,
  vehicles: (businessId?: string) => [...FLEET_KEYS.all, "vehicles", businessId] as const,
  vehicleDetail: (id: string) => [...FLEET_KEYS.all, "vehicle", id] as const,
  dashboard: (businessId?: string) => [...FLEET_KEYS.all, "dashboard", businessId] as const,
  earnings: () => [...FLEET_KEYS.all, "earnings"] as const,
  joinRequests: (businessId?: string) => [...FLEET_KEYS.all, "join-requests", businessId] as const,
  invitations: (businessId?: string) => [...FLEET_KEYS.all, "invitations", businessId] as const,
};

function useBusinessId(): string | undefined {
  const id = useSyncExternalStore(subscribeBusiness, () => getActiveBusiness()?.id ?? null, () => null);
  return id ?? undefined;
}
function useIsAuthenticated(): boolean {
  const token = useSyncExternalStore(subscribeAuth, () => getAuthToken(), () => null);
  return !!token;
}

const OFFLINE_FIRST = { retry: false, networkMode: "offlineFirst" } as const;

// Fleet has no SQLite mirror — offline source is the persisted query cache.
// Reads are cache-first (no online gate): the query is enabled offline so
// TanStack can serve stale cache + OfflineBanner marks not-live. Fetches still
// fail gracefully via retry:false + offlineFirst when the network is down.
function useOnline(): boolean {
  return useIsEffectivelyOnline();
}

// ─── Riders ───

export function useFleetRidersQuery(enabled = true, filters?: { q?: string; status?: string }) {
  const businessId = useBusinessId();
  const isAuthenticated = useIsAuthenticated();
  return useQuery({
    queryKey: [...FLEET_KEYS.riders(businessId), filters],
    queryFn: () => fleetService.fetchFleetRiders(businessId, 1, 50, filters),
    enabled: enabled && Boolean(businessId) && isAuthenticated,
    placeholderData: (prev) => prev,
    ...OFFLINE_FIRST,
  });
}

export function useInviteRiderMutation() {
  const businessId = useBusinessId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => {
      assertOnlineFor("member:invite");
      validateInviteInput({ email: (data as { email?: unknown }).email ?? (data as { invited_email?: unknown }).invited_email });
      return fleetService.inviteRider(data, businessId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: FLEET_KEYS.riders(businessId) });
    },
  });
}

export function useFleetRiderQuery(riderId: string, enabled = true) {
  const businessId = useBusinessId();
  return useQuery({
    queryKey: FLEET_KEYS.riderDetail(riderId),
    queryFn: () => fleetService.fetchFleetRider(riderId, businessId),
    enabled: enabled && Boolean(riderId),
    placeholderData: (prev) => prev,
    ...OFFLINE_FIRST,
  });
}

export function useRiderKycQuery(riderId: string, enabled = true) {
  const businessId = useBusinessId();
  return useQuery({
    queryKey: FLEET_KEYS.riderKyc(riderId),
    queryFn: () => fleetService.fetchRiderKyc(riderId, businessId),
    enabled: enabled && Boolean(riderId),
    staleTime: 0,
    placeholderData: (prev) => prev,
    ...OFFLINE_FIRST,
  });
}

export function useApproveRiderMutation() {
  const businessId = useBusinessId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (riderId: string) => {
      assertOnlineFor("member:manage");
      return fleetService.approveRider(riderId, businessId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: FLEET_KEYS.riders(businessId) });
    },
  });
}

export function useSuspendRiderMutation() {
  const businessId = useBusinessId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (riderId: string) => {
      assertOnlineFor("member:manage");
      return fleetService.suspendRider(riderId, businessId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: FLEET_KEYS.riders(businessId) });
    },
  });
}

export function useActivateRiderMutation() {
  const businessId = useBusinessId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (riderId: string) => {
      assertOnlineFor("member:manage");
      return fleetService.activateRider(riderId, businessId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: FLEET_KEYS.riders(businessId) });
    },
  });
}

export function useJoinRequestsQuery(enabled = true) {
  const businessId = useBusinessId();
  const isAuthenticated = useIsAuthenticated();
  return useQuery({
    queryKey: FLEET_KEYS.joinRequests(businessId),
    queryFn: () => fleetService.fetchJoinRequests(businessId),
    enabled: enabled && Boolean(businessId) && isAuthenticated,
    placeholderData: (prev) => prev,
    ...OFFLINE_FIRST,
  });
}

export function useApproveJoinRequestMutation() {
  const businessId = useBusinessId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) => {
      assertOnlineFor("member:manage");
      return fleetService.approveJoinRequest(requestId, businessId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: FLEET_KEYS.joinRequests(businessId) });
      queryClient.invalidateQueries({ queryKey: FLEET_KEYS.riders(businessId) });
    },
  });
}

export function useRejectJoinRequestMutation() {
  const businessId = useBusinessId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (requestId: string) => {
      assertOnlineFor("member:manage");
      return fleetService.rejectJoinRequest(requestId, businessId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: FLEET_KEYS.joinRequests(businessId) });
    },
  });
}

export function useFleetInvitationsQuery(enabled = true) {
  const businessId = useBusinessId();
  const isAuthenticated = useIsAuthenticated();
  return useQuery({
    queryKey: FLEET_KEYS.invitations(businessId),
    queryFn: () => fleetService.fetchInvitations(businessId),
    enabled: enabled && Boolean(businessId) && isAuthenticated,
    placeholderData: (prev) => prev,
    ...OFFLINE_FIRST,
  });
}

export function useRevokeInvitationMutation() {
  const businessId = useBusinessId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) => {
      assertOnlineFor("member:manage");
      return fleetService.revokeInvitation(invitationId, businessId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: FLEET_KEYS.invitations(businessId) });
    },
  });
}

// ─── Vehicles ───

export function useFleetVehiclesQuery(enabled = true) {
  const businessId = useBusinessId();
  const isAuthenticated = useIsAuthenticated();
  return useQuery({
    queryKey: FLEET_KEYS.vehicles(businessId),
    queryFn: () => fleetService.fetchFleetVehicles(businessId),
    enabled: enabled && Boolean(businessId) && isAuthenticated,
    placeholderData: (prev) => prev,
    ...OFFLINE_FIRST,
  });
}

export function useAddVehicleMutation() {
  const businessId = useBusinessId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<FleetVehicle>) => {
      assertOnlineFor("fleet:manage");
      return fleetService.addVehicle(data as Record<string, unknown>, businessId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: FLEET_KEYS.vehicles(businessId) });
    },
  });
}

export function useRemoveVehicleMutation() {
  const businessId = useBusinessId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vehicleId: string) => {
      assertOnlineFor("fleet:manage");
      return fleetService.removeVehicle(vehicleId, businessId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: FLEET_KEYS.vehicles(businessId) });
    },
  });
}

// ─── Dashboard ───

export function useFleetDashboardQuery(enabled = true) {
  const businessId = useBusinessId();
  const isAuthenticated = useIsAuthenticated();
  return useQuery({
    queryKey: FLEET_KEYS.dashboard(businessId),
    queryFn: () => fleetService.fetchFleetDashboard(businessId),
    enabled: enabled && Boolean(businessId) && isAuthenticated,
    placeholderData: (prev) => prev,
    ...OFFLINE_FIRST,
  });
}
