/**
 * Catalog hooks — offline-first menu browsing
 * Port of TeincFoodBusiness/src/hooks/menu.hooks.ts
 * Uses reference_data SQLite cache + network refresh when online.
 */

import { useMemo } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { getConnectivityState, subscribeConnectivity } from "../adapters/connectivity";
import { menuService } from "../adapters/services";
import { getReferenceData } from "../reference/operations";
import { openSyncDatabase } from "../db/connection";
import { referenceSyncService } from "../reference/service";
import { emitReferenceChanged } from "../reference/events";
import { runOfflineCapableMutation } from "../sync/offline-capable";
import type { MenuItemListResponse, MenuCategoryListResponse } from "../types/api";
import { useIsEffectivelyOnline } from "../hooks/use-infinite-list";

export const CATALOG_KEYS = {
  all: ["menu"] as const,
  items: (businessId?: string) => [...CATALOG_KEYS.all, "items", businessId] as const,
  categories: (businessId?: string) => [...CATALOG_KEYS.all, "categories", businessId] as const,
} as const;

function useBusinessId(): string | undefined {
  const id = useSyncExternalStore(subscribeBusiness, () => getActiveBusiness()?.id ?? null, () => null);
  return id ?? undefined;
}

export function useMenuItemsQuery(filters?: { search?: string; category_ids?: string; sort?: string }, enabled = true) {
  const businessId = useBusinessId();
  const isOnline = useIsEffectivelyOnline();

  // Cached reference query — synchronous from SQLite via query
  const cachedQuery = useQuery({
    queryKey: [...CATALOG_KEYS.items(businessId), "cached", filters],
    queryFn: async () => {
      if (!businessId) return null;
      const db = await openSyncDatabase();
      const rec = await getReferenceData<MenuItemListResponse>(db, businessId, "menu:items");
      return rec?.payload ?? null;
    },
    enabled: enabled && !!businessId,
    staleTime: Infinity,
  });

  const filtered = useMemo(() => {
    const all = (cachedQuery.data as unknown as { data?: unknown[] })?.data ?? [];
    if (!enabled) return [] as unknown[];
    let out: unknown[] = all as unknown[];
    if (filters?.category_ids) {
      const ids = new Set(filters.category_ids.split(",").map((s) => s.trim()).filter(Boolean));
      if (ids.size > 0) out = (out as { category_id?: string; categoryId?: string }[]).filter((i) => ids.has((i.category_id ?? i.categoryId) ?? ""));
    }
    if (filters?.search) {
      const q = filters.search.trim().toLowerCase();
      if (q) out = (out as { name?: string; description?: string }[]).filter((i) => (i.name ?? "").toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q));
    }
    return out;
  }, [cachedQuery.data, filters?.category_ids, filters?.search, enabled]);

  const networkQuery = useInfiniteQuery({
    queryKey: [...CATALOG_KEYS.items(businessId), filters, "network"],
    queryFn: ({ pageParam = 1 }) => (menuService as unknown as { fetchBusinessMenuItems: (bid: string, page: number, f?: unknown) => Promise<unknown> }).fetchBusinessMenuItems(businessId!, pageParam as number, filters),
    initialPageParam: 1,
    getNextPageParam: (lastPage: unknown) => {
      const p = (lastPage as { pagination?: { page: number; total_pages: number } })?.pagination;
      return p && p.page < p.total_pages ? p.page + 1 : undefined;
    },
    enabled: enabled && !!businessId && isOnline,
    staleTime: 30 * 1000,
    retry: false,
    networkMode: "offlineFirst" as const,
  });

  const networkData = (networkQuery.data as { pages?: { data: unknown[] }[] } | undefined)?.pages
    ? (networkQuery.data as { pages: { data: unknown[] }[] }).pages.flatMap((p) => p.data)
    : undefined;

  const data = isOnline && networkData !== undefined ? networkData : enabled ? filtered : undefined;

  return {
    data,
    isPending: cachedQuery.isPending && !networkData,
    isFetching: networkQuery.isFetching,
    isError: cachedQuery.isError || networkQuery.isError,
    error: (cachedQuery.error ?? networkQuery.error) as unknown,
    refetch: async () => {
      if (!businessId) return;
      if (isOnline) await referenceSyncService.sync({ businessId, keys: ["menu:items", "menu:categories"] });
      return networkQuery.refetch();
    },
    fetchNextPage: networkQuery.fetchNextPage,
    hasNextPage: networkQuery.hasNextPage,
    isFetchingNextPage: networkQuery.isFetchingNextPage,
  } as unknown as ReturnType<typeof useInfiniteQuery> & { data: unknown[] | undefined };
}

export function useMenuCategoriesQuery() {
  const businessId = useBusinessId();
  const isOnline = useIsEffectivelyOnline();
  const cachedQuery = useQuery({
    queryKey: [...CATALOG_KEYS.categories(businessId), "cached"],
    queryFn: async () => {
      if (!businessId) return null;
      const db = await openSyncDatabase();
      const rec = await getReferenceData<MenuCategoryListResponse>(db, businessId, "menu:categories");
      return rec?.payload ?? null;
    },
    enabled: !!businessId,
    staleTime: Infinity,
  });
  const networkQuery = useQuery({
    queryKey: CATALOG_KEYS.categories(businessId),
    queryFn: () => (menuService as unknown as { fetchBusinessCategories: (bid: string) => Promise<unknown> }).fetchBusinessCategories(businessId!),
    enabled: !!businessId && isOnline,
    staleTime: 30 * 1000,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
  const usingNetwork = isOnline && (networkQuery.data as unknown);
  const data = usingNetwork ? networkQuery.data : cachedQuery.data;
  const hasCache = cachedQuery.data != null;
  return {
    ...networkQuery,
    data,
    isPending: cachedQuery.isPending && !networkQuery.data,
    isError: hasCache ? false : networkQuery.isError,
    error: hasCache ? null : networkQuery.error,
  } as unknown as ReturnType<typeof useQuery>;
}

// Mutations — offline-capable
export function useCreateMenuItemMutation() {
  const businessId = useBusinessId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) => {
      // cacheRecord is local-cache only — never on the wire.
      const { cacheRecord: _omit, ...wire } = payload;
      void _omit;
      return runOfflineCapableMutation({ run: () => (menuService as unknown as { createMenuItem: (p: unknown) => Promise<unknown> }).createMenuItem(wire), commandType: "menu:create_item", businessId: businessId!, entityId: (payload as { id?: string }).id, payload });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CATALOG_KEYS.items(businessId) });
      if (businessId) emitReferenceChanged(businessId, ["menu:items"]);
    },
  });
}
export function useUpdateMenuItemMutation() {
  const businessId = useBusinessId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) => {
      const { cacheRecord: _omit, ...wire } = payload;
      void _omit;
      return runOfflineCapableMutation({ run: () => (menuService as unknown as { updateMenuItem: (id: string, p: unknown) => Promise<unknown> }).updateMenuItem(id, wire), commandType: "menu:update_item", businessId: businessId!, entityId: id, payload });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CATALOG_KEYS.items(businessId) });
      if (businessId) emitReferenceChanged(businessId, ["menu:items"]);
    },
  });
}
export function useDeleteMenuItemMutation() {
  const businessId = useBusinessId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      runOfflineCapableMutation({ run: () => (menuService as unknown as { deleteMenuItem: (id: string) => Promise<unknown> }).deleteMenuItem(id), commandType: "menu:delete_item", businessId: businessId!, entityId: id, payload: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CATALOG_KEYS.items(businessId) });
      if (businessId) emitReferenceChanged(businessId, ["menu:items"]);
    },
  });
}
export function useToggleItemAvailabilityMutation() {
  const businessId = useBusinessId();
  const qc = useQueryClient();
  return useMutation({
    // Availability is an update_item with an availability patch — same engine
    // route (cloud → LAN → queue), same cache convergence.
    mutationFn: ({ id, available }: { id: string; available: boolean }) =>
      runOfflineCapableMutation({ run: () => (menuService as unknown as { updateMenuItem: (id: string, p: unknown) => Promise<unknown> }).updateMenuItem(id, { available }), commandType: "menu:update_item", businessId: businessId!, entityId: id, payload: { id, available } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CATALOG_KEYS.items(businessId) });
      if (businessId) emitReferenceChanged(businessId, ["menu:items"]);
    },
  });
}
export function useCreateMenuCategoryMutation() {
  const businessId = useBusinessId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) => {
      const { cacheRecord: _omit, ...wire } = payload;
      void _omit;
      return runOfflineCapableMutation({ run: () => (menuService as unknown as { createCategory: (b: string, p: unknown) => Promise<unknown> }).createCategory(businessId!, wire), commandType: "menu:create_category", businessId: businessId!, entityId: (payload as { id?: string }).id, payload });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CATALOG_KEYS.categories(businessId) });
      if (businessId) emitReferenceChanged(businessId, ["menu:categories"]);
    },
  });
}
export function useUpdateMenuCategoryMutation() {
  const businessId = useBusinessId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) => {
      const { cacheRecord: _omit, ...wire } = payload;
      void _omit;
      return runOfflineCapableMutation({ run: () => (menuService as unknown as { updateCategory: (id: string, p: unknown) => Promise<unknown> }).updateCategory(id, wire), commandType: "menu:update_category", businessId: businessId!, entityId: id, payload: { ...payload, id } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CATALOG_KEYS.categories(businessId) });
      if (businessId) emitReferenceChanged(businessId, ["menu:categories"]);
    },
  });
}
export function useDeleteMenuCategoryMutation() {
  const businessId = useBusinessId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      runOfflineCapableMutation({ run: () => (menuService as unknown as { deleteCategory: (id: string) => Promise<unknown> }).deleteCategory(id), commandType: "menu:delete_category", businessId: businessId!, entityId: id, payload: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CATALOG_KEYS.categories(businessId) });
      if (businessId) emitReferenceChanged(businessId, ["menu:categories"]);
    },
  });
}
