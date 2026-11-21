/**
 * Members / invitations / roles / tax hooks — single source for both apps.
 * Reads serve the SQLite reference cache instantly; network refreshes
 * silently when online. Invites and management mutations require online.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { getAuthToken, subscribeAuth } from "../adapters/auth";
import { businessService, rolesService, fleetService } from "../adapters/services";
import { assertOnlineFor } from "../sync/online-gates";
import { runOfflineCapableMutation } from "../sync/offline-capable";
import { removeOfflineMember, updateOfflineMemberRole } from "../offline/store";
import { validateInviteInput } from "../validation/offline";
import { notifySuccess, notifyError } from "../adapters/notify";
import { extractApiErrorMessage } from "../utils/error";
import { emitReferenceChanged } from "../reference/events";
import { useReferenceData } from "../reference/hooks";
import { useIsEffectivelyOnline } from "./use-infinite-list";
import type {
  BusinessMemberDetailResponse,
  BusinessMemberListResponse,
  RolesResponse,
  TaxRuleListResponse,
} from "../types/api/business.api";

function useBusinessId(): string | undefined {
  const id = useSyncExternalStore(subscribeBusiness, () => getActiveBusiness()?.id ?? null, () => null);
  return id ?? undefined;
}
function useIsAuthenticated(): boolean {
  const token = useSyncExternalStore(subscribeAuth, () => getAuthToken(), () => null);
  return !!token;
}

const OFFLINE_FIRST = { retry: false, networkMode: "offlineFirst" } as const;

function isQueued(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && (result as { status?: unknown }).status === "pending");
}

// ─── Keys ───

export const MEMBER_KEYS = {
  all: ["business-members"] as const,
  list: (businessId?: string) => [...MEMBER_KEYS.all, businessId] as const,
  detail: (businessId?: string, userId?: string) =>
    [...MEMBER_KEYS.all, businessId, "detail", userId] as const,
  invitations: (businessId?: string) => [...MEMBER_KEYS.all, businessId, "invitations"] as const,
};

export const INVITATION_KEYS = {
  all: ["invitations"] as const,
  list: () => [...INVITATION_KEYS.all, "list"] as const,
};

export const ROLES_KEYS = {
  all: ["business-roles"] as const,
  forBusiness: (businessId?: string) => [...ROLES_KEYS.all, businessId] as const,
};

export const TAX_KEYS = {
  all: ["tax-rules"] as const,
  list: (businessId?: string) => [...TAX_KEYS.all, "list", businessId] as const,
};

// ─── Members ───

export function useBusinessMembersQuery() {
  const businessId = useBusinessId();
  const cached = useReferenceData<BusinessMemberListResponse>("members");
  const online = useIsEffectivelyOnline();
  const isAuthenticated = useIsAuthenticated();

  const q = useQuery({
    queryKey: MEMBER_KEYS.list(businessId ?? ""),
    queryFn: () => (businessService as unknown as { fetchBusinessMembers: (b: string) => Promise<unknown> }).fetchBusinessMembers(businessId!),
    enabled: Boolean(businessId) && online && isAuthenticated,
    staleTime: 30 * 1000,
    ...OFFLINE_FIRST,
    placeholderData: cached.data?.payload,
  });
  // Offline: SQLite cache directly so screens stay populated when down.
  return { ...q, data: (q.data as unknown) ?? cached.data?.payload } as typeof q;
}

export function useBusinessMemberQuery(userId?: string | null, enabled = true) {
  const businessId = useBusinessId();
  const online = useIsEffectivelyOnline();
  const isAuthenticated = useIsAuthenticated();

  const q = useQuery({
    queryKey: MEMBER_KEYS.detail(businessId ?? "", userId ?? ""),
    queryFn: () =>
      (
        businessService as unknown as {
          fetchBusinessMember: (b: string, u: string) => Promise<BusinessMemberDetailResponse>;
        }
      ).fetchBusinessMember(businessId!, userId!),
    enabled: enabled && Boolean(businessId && userId) && online && isAuthenticated,
    ...OFFLINE_FIRST,
  });

  return q;
}

export function useInviteMemberMutation() {
  const queryClient = useQueryClient();
  const businessId = useBusinessId();

  return useMutation({
    mutationFn: (data: { email?: string; phone?: string; role?: string }) => {
      if (!businessId) throw new Error("No active business");
      validateInviteInput({ email: data.email, phone: data.phone });
      return runOfflineCapableMutation<unknown, Record<string, unknown>>({
        run: () =>
          (businessService as unknown as { inviteBusinessMember: (b: string, d: unknown) => Promise<unknown> }).inviteBusinessMember(
            businessId,
            data,
          ),
        commandType: "member:invite",
        businessId,
        payload: data as Record<string, unknown>,
      });
    },
    onSuccess: (result) => {
      notifySuccess(
        isQueued(result)
          ? "Invitation queued — it will send when this device reconnects."
          : "Invitation sent!",
      );
      queryClient.invalidateQueries({ queryKey: MEMBER_KEYS.list(businessId ?? "") });
      if (businessId) emitReferenceChanged(businessId, ["members"]);
    },
    onError: (error) => {
      notifyError(extractApiErrorMessage(error));
    },
  });
}

export function useRemoveMemberMutation() {
  const queryClient = useQueryClient();
  const businessId = useBusinessId();

  return useMutation({
    mutationFn: (userId: string) => {
      if (!businessId) throw new Error("No active business");
      return runOfflineCapableMutation<unknown, Record<string, unknown>>({
        run: () =>
          (businessService as unknown as { removeBusinessMember: (b: string, u: string) => Promise<unknown> }).removeBusinessMember(
            businessId,
            userId,
          ),
        commandType: "member:remove",
        businessId,
        entityId: userId,
        payload: { user_id: userId },
      });
    },
    onSuccess: async (result, userId) => {
      // Revoke local offline access immediately, even when the server command
      // is queued. Otherwise a removed member can still unlock this terminal.
      if (businessId) {
        await removeOfflineMember(userId, businessId).catch(() => undefined);
      }
      notifySuccess(isQueued(result) ? "Member removal queued" : "Member removed");
      queryClient.invalidateQueries({ queryKey: MEMBER_KEYS.list(businessId ?? "") });
      if (businessId) emitReferenceChanged(businessId, ["members"]);
    },
    onError: (error) => {
      notifyError(extractApiErrorMessage(error));
    },
  });
}

export function useUpdateMemberRoleMutation() {
  const queryClient = useQueryClient();
  const businessId = useBusinessId();

  return useMutation({
    mutationFn: ({ userId, role, status }: { userId: string; role?: string; status?: string }) => {
      if (!businessId) throw new Error("No active business");
      const payload = { ...(role ? { role } : {}), ...(status ? { status } : {}) };
      return runOfflineCapableMutation<unknown, Record<string, unknown>>({
        run: () =>
          (businessService as unknown as { updateBusinessMember: (b: string, u: string, d: unknown) => Promise<unknown> }).updateBusinessMember(
            businessId,
            userId,
            payload,
          ),
        commandType: "member:update",
        businessId,
        entityId: userId,
        payload,
      });
    },
    onSuccess: async (result, variables) => {
      if (businessId && variables.role) {
        await updateOfflineMemberRole(variables.userId, businessId, variables.role).catch(
          () => undefined,
        );
      }
      notifySuccess(isQueued(result) ? "Role change queued" : "Member role updated");
      queryClient.invalidateQueries({ queryKey: MEMBER_KEYS.list(businessId ?? "") });
      if (businessId) emitReferenceChanged(businessId, ["members"]);
    },
    onError: (error) => {
      notifyError(extractApiErrorMessage(error));
    },
  });
}

export function useBusinessMemberInvitationsQuery() {
  const businessId = useBusinessId();
  // No invitations SQLite mirror — never fire while unreachable or logged-out.
  const online = useIsEffectivelyOnline();
  const isAuthenticated = useIsAuthenticated();

  return useQuery({
    queryKey: MEMBER_KEYS.invitations(businessId ?? ""),
    queryFn: () =>
      (businessService as unknown as { fetchBusinessMemberInvitations: (b: string) => Promise<unknown> }).fetchBusinessMemberInvitations(businessId!),
    enabled: Boolean(businessId) && online && isAuthenticated,
    ...OFFLINE_FIRST,
  });
}

export function useRevokeMemberInvitationMutation() {
  const queryClient = useQueryClient();
  const businessId = useBusinessId();

  return useMutation({
    mutationFn: (invitationId: string) => {
      assertOnlineFor("member:manage");
      return (businessService as unknown as { revokeBusinessMemberInvitation: (b: string, i: string) => Promise<unknown> }).revokeBusinessMemberInvitation(businessId!, invitationId);
    },
    onSuccess: () => {
      notifySuccess("Invitation revoked");
      queryClient.invalidateQueries({ queryKey: MEMBER_KEYS.invitations(businessId ?? "") });
      if (businessId) emitReferenceChanged(businessId, ["members"]);
    },
    onError: (error) => {
      notifyError(extractApiErrorMessage(error));
    },
  });
}

export function useDeleteMemberInvitationMutation() {
  const queryClient = useQueryClient();
  const businessId = useBusinessId();

  return useMutation({
    mutationFn: (invitationId: string) => {
      assertOnlineFor("member:manage");
      return (businessService as unknown as { deleteBusinessMemberInvitation: (b: string, i: string) => Promise<unknown> }).deleteBusinessMemberInvitation(businessId!, invitationId);
    },
    onSuccess: () => {
      notifySuccess("Invitation deleted");
      queryClient.invalidateQueries({ queryKey: MEMBER_KEYS.invitations(businessId ?? "") });
      if (businessId) emitReferenceChanged(businessId, ["members"]);
    },
    onError: (error) => {
      notifyError(extractApiErrorMessage(error));
    },
  });
}

// ─── User invitations ───

export function useUserInvitationsQuery() {
  // User-scoped: requires login. Don't 401 while logged-out.
  const online = useIsEffectivelyOnline();
  const isAuthenticated = useIsAuthenticated();
  return useQuery({
    queryKey: INVITATION_KEYS.list(),
    queryFn: () => (businessService as unknown as { fetchUserInvitations: () => Promise<unknown> }).fetchUserInvitations(),
    enabled: online && isAuthenticated,
    staleTime: 15000,
    ...OFFLINE_FIRST,
  });
}

export function useLeaveBusinessMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (invitationId: string) => {
      assertOnlineFor("member:manage");
      return (businessService as unknown as { leaveBusiness: (i: string) => Promise<unknown> }).leaveBusiness(invitationId);
    },
    onSuccess: () => {
      notifySuccess("Left the business");
      queryClient.invalidateQueries({ queryKey: INVITATION_KEYS.list() });
    },
    onError: (error) => {
      notifyError(extractApiErrorMessage(error));
    },
  });
}

export function useAcceptFleetInvitationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { code: string }) => {
      assertOnlineFor("member:manage");
      return (fleetService as unknown as { acceptFleetInvitation: (d: unknown) => Promise<unknown> }).acceptFleetInvitation(data);
    },
    onSuccess: () => {
      notifySuccess("You have joined the business!");
      queryClient.invalidateQueries({ queryKey: INVITATION_KEYS.list() });
    },
    onError: (error) => {
      notifyError(extractApiErrorMessage(error));
    },
  });
}

export function useAcceptBusinessInvitationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { code: string }) => {
      assertOnlineFor("member:manage");
      return (businessService as unknown as { acceptBusinessInvitation: (d: unknown) => Promise<unknown> }).acceptBusinessInvitation(data);
    },
    onSuccess: (result) => {
      const businessId =
        (result as { data?: { business_id?: string } })?.data?.business_id ?? undefined;
      notifySuccess("Invitation accepted!");
      queryClient.invalidateQueries({ queryKey: INVITATION_KEYS.list() });
      // A newly joined business must appear in "my businesses" immediately,
      // even when the store was populated before the invite was accepted.
      queryClient.invalidateQueries({ queryKey: ["businesses"] });
      queryClient.invalidateQueries({ queryKey: ["businesses", "relationships"] });
      queryClient.invalidateQueries({ queryKey: MEMBER_KEYS.all });
      if (businessId) queryClient.invalidateQueries({ queryKey: MEMBER_KEYS.list(businessId) });
      return result;
    },
    onError: (error) => {
      notifyError(extractApiErrorMessage(error));
    },
  });
}

export function useDeclineBusinessInvitationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { code: string }) => {
      assertOnlineFor("member:manage");
      return (businessService as unknown as { declineBusinessInvitation: (d: unknown) => Promise<unknown> }).declineBusinessInvitation(data);
    },
    onSuccess: () => {
      notifySuccess("Invitation declined");
      queryClient.invalidateQueries({ queryKey: INVITATION_KEYS.list() });
    },
    onError: (error) => {
      notifyError(extractApiErrorMessage(error));
    },
  });
}

export function useResendMemberInvitationMutation() {
  const queryClient = useQueryClient();
  const businessId = useBusinessId();

  return useMutation({
    mutationFn: (invitationId: string) => {
      assertOnlineFor("member:manage");
      return (businessService as unknown as { resendBusinessMemberInvitation: (b: string, i: string) => Promise<unknown> }).resendBusinessMemberInvitation(businessId!, invitationId);
    },
    onSuccess: () => {
      notifySuccess("Invitation resent");
      queryClient.invalidateQueries({ queryKey: MEMBER_KEYS.invitations(businessId ?? "") });
    },
    onError: (error) => {
      notifyError(extractApiErrorMessage(error));
    },
  });
}

// ─── Roles ───

export function useBusinessRolesQuery(enabled = true) {
  const businessId = useBusinessId();
  const cached = useReferenceData<RolesResponse>("roles");
  const online = useIsEffectivelyOnline();
  const isAuthenticated = useIsAuthenticated();
  const q = useQuery({
    queryKey: ROLES_KEYS.forBusiness(businessId),
    queryFn: () => rolesService.fetchBusinessRoles(),
    staleTime: Infinity,
    enabled: enabled && !!businessId && online && isAuthenticated,
    ...OFFLINE_FIRST,
    placeholderData: cached.data?.payload,
  });
  return { ...q, data: (q.data as unknown) ?? cached.data?.payload } as typeof q;
}

// ─── Tax rules ───

export function useBusinessTaxRulesQuery(enabled = true) {
  const businessId = useBusinessId();
  const cached = useReferenceData<TaxRuleListResponse>("tax-rules");
  const online = useIsEffectivelyOnline();
  const isAuthenticated = useIsAuthenticated();
  const q = useQuery({
    queryKey: TAX_KEYS.list(businessId),
    queryFn: () =>
      (businessService as unknown as { fetchBusinessTaxRules: (b: string) => Promise<unknown> }).fetchBusinessTaxRules(businessId!),
    enabled: enabled && Boolean(businessId) && online && isAuthenticated,
    staleTime: 30 * 1000,
    ...OFFLINE_FIRST,
    placeholderData: cached.data?.payload,
  });
  return { ...q, data: (q.data as unknown) ?? cached.data?.payload } as typeof q;
}

export function useCreateTaxRuleMutation() {
  const queryClient = useQueryClient();
  const businessId = useBusinessId();

  return useMutation({
    mutationFn: (data: Record<string, unknown>) => {
      assertOnlineFor("settings:manage");
      return (businessService as unknown as { createBusinessTaxRule: (b: string, d: unknown) => Promise<unknown> }).createBusinessTaxRule(businessId!, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TAX_KEYS.list(businessId) });
      notifySuccess("Tax rule created");
      if (businessId) emitReferenceChanged(businessId, ["tax-rules"]);
    },
    onError: (err) => {
      try {
        console.debug("[TaxHook] Create failed", err);
      } catch {}
      notifyError(extractApiErrorMessage(err));
    },
  });
}

export function useUpdateTaxRuleMutation() {
  const queryClient = useQueryClient();
  const businessId = useBusinessId();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => {
      assertOnlineFor("settings:manage");
      return (businessService as unknown as { updateTaxRule: (i: string, d: unknown) => Promise<unknown> }).updateTaxRule(id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TAX_KEYS.list(businessId) });
      notifySuccess("Tax rule updated");
      if (businessId) emitReferenceChanged(businessId, ["tax-rules"]);
    },
    onError: (err) => {
      try {
        console.debug("[TaxHook] Update failed", err);
      } catch {}
      notifyError(extractApiErrorMessage(err));
    },
  });
}

export function useDeleteTaxRuleMutation() {
  const queryClient = useQueryClient();
  const businessId = useBusinessId();

  return useMutation({
    mutationFn: (id: string) => {
      assertOnlineFor("settings:manage");
      return (businessService as unknown as { deleteTaxRule: (i: string) => Promise<unknown> }).deleteTaxRule(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: TAX_KEYS.list(businessId) });
      notifySuccess("Tax rule removed");
      if (businessId) emitReferenceChanged(businessId, ["tax-rules"]);
    },
    onError: (err) => {
      try {
        console.debug("[TaxHook] Delete failed", err);
      } catch {}
      notifyError(extractApiErrorMessage(err));
    },
  });
}

