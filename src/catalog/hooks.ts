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
import { commitMenuMutationLocal } from "../sync/offline-capable";
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

  // A local snapshot (even an empty list) means the POS has something to
  // render: never gate the whole screen on the in-flight network refresh.
  const hasLocalSnapshot = cachedQuery.data != null;

  // Local SQLite is the read model whenever it has a snapshot. The network
  // query is only a cold-start fallback; it must never resurrect a row that
  // was deleted/updated locally and is still waiting to sync.
  const data = hasLocalSnapshot
    ? enabled
      ? filtered
      : undefined
    : isOnline && networkData !== undefined
      ? networkData
      : enabled
        ? filtered
        : undefined;
  const pending =
    cachedQuery.isPending || (!hasLocalSnapshot && networkQuery.isFetching);

  return {
    data,
    isPending: pending,
    isLoading: pending,
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
  const hasCache = cachedQuery.data != null;
  // Local categories are authoritative once a snapshot exists. The network
  // response must not re-show a category that was just deleted offline.
  const data = hasCache
    ? cachedQuery.data
    : isOnline
      ? networkQuery.data
      : cachedQuery.data;
  // Only report "loading" when there is nothing local to show; the network
  // refresh must never hide an already-cached category list.
  const pending = cachedQuery.isPending || (!hasCache && networkQuery.isFetching);
  return {
    ...networkQuery,
    data,
    isPending: pending,
    isLoading: pending,
    isError: hasCache ? false : networkQuery.isError,
    error: hasCache ? null : networkQuery.error,
  } as unknown as ReturnType<typeof useQuery>;
}

type QuerySnapshot = Array<[readonly unknown[], unknown]>;

function restoreQuerySnapshots(
  qc: ReturnType<typeof useQueryClient>,
  snapshot: QuerySnapshot | undefined,
): void {
  if (!snapshot) return;
  for (const [key, data] of snapshot) {
    qc.setQueryData(key as unknown[], data);
  }
}

function recordId(record: unknown): string | undefined {
  const id = (record as { id?: unknown } | null | undefined)?.id;
  return id == null ? undefined : String(id);
}

/**
 * Patch a menu query payload regardless of shape: the SQLite-backed query is
 * `{ data: [...] }`, the network query is `{ pages: [{ data: [...] }] }`.
 * This lets one optimistic patch update every mounted variant at once.
 */
function patchMenuRows(
  old: unknown,
  patch: (rows: unknown[]) => unknown[],
): unknown {
  if (Array.isArray(old)) return patch(old);
  if (!old || typeof old !== "object") return old;
  const obj = old as Record<string, unknown>;
  if (Array.isArray(obj.data)) {
    return { ...obj, data: patch(obj.data) };
  }
  if (Array.isArray(obj.pages)) {
    return {
      ...obj,
      pages: obj.pages.map((page) => {
        if (!page || typeof page !== "object") return page;
        const p = page as Record<string, unknown>;
        return Array.isArray(p.data) ? { ...p, data: patch(p.data) } : page;
      }),
    };
  }
  return old;
}

function upsertMenuRow(rows: unknown[], record: unknown): unknown[] {
  const id = recordId(record);
  if (!id) return rows;
  const index = rows.findIndex((row) => recordId(row) === id);
  if (index >= 0) {
    return rows.map((row, i) =>
      i === index ? { ...(row as object), ...(record as object) } : row,
    );
  }
  return [record, ...rows];
}

function removeMenuRow(rows: unknown[], id: string): unknown[] {
  return rows.filter((row) => recordId(row) !== id);
}

function useOptimisticMenuPatch() {
  const qc = useQueryClient();
  const snapshot = (queryKey: readonly unknown[]): QuerySnapshot =>
    qc.getQueriesData({ queryKey }) as QuerySnapshot;
  return { qc, snapshot, restore: (s: QuerySnapshot | undefined) => restoreQuerySnapshots(qc, s) };
}

// Mutations — local-first.
//
// The only work on the mutation path is the local SQLite commit. Reference
// fan-out and cloud/LAN replay are scheduled by commitMenuMutationLocal AFTER
// the outbox row exists, so a slow or absent network can never delay a save.
// Invalidating the cached query key makes the committed row render immediately.
export function useCreateMenuItemMutation() {
  const businessId = useBusinessId();
  const { qc, snapshot, restore } = useOptimisticMenuPatch();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      commitMenuMutationLocal({
        commandType: "menu:create_item",
        businessId: businessId!,
        entityId: (payload as { id?: string }).id,
        payload,
      }),
    onMutate: (payload) => {
      const record = (payload as { cacheRecord?: unknown }).cacheRecord;
      const prev = snapshot(CATALOG_KEYS.items(businessId));
      if (record) {
        qc.setQueriesData({ queryKey: CATALOG_KEYS.items(businessId) }, (old) =>
          patchMenuRows(old, (rows) => upsertMenuRow(rows, record)),
        );
      }
      return { prev };
    },
    onError: (_error, _vars, ctx) =>
      restore((ctx as { prev?: QuerySnapshot } | undefined)?.prev),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CATALOG_KEYS.items(businessId) });
    },
  });
}
export function useUpdateMenuItemMutation() {
  const businessId = useBusinessId();
  const { qc, snapshot, restore } = useOptimisticMenuPatch();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      commitMenuMutationLocal({
        commandType: "menu:update_item",
        businessId: businessId!,
        entityId: id,
        payload,
      }),
    onMutate: ({ payload }) => {
      const record = (payload as { cacheRecord?: unknown }).cacheRecord;
      const prev = snapshot(CATALOG_KEYS.items(businessId));
      if (record) {
        qc.setQueriesData({ queryKey: CATALOG_KEYS.items(businessId) }, (old) =>
          patchMenuRows(old, (rows) => upsertMenuRow(rows, record)),
        );
      }
      return { prev };
    },
    onError: (_error, _vars, ctx) =>
      restore((ctx as { prev?: QuerySnapshot } | undefined)?.prev),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CATALOG_KEYS.items(businessId) });
    },
  });
}
export function useDeleteMenuItemMutation() {
  const businessId = useBusinessId();
  const { qc, snapshot, restore } = useOptimisticMenuPatch();
  return useMutation({
    mutationFn: (id: string) =>
      commitMenuMutationLocal({
        commandType: "menu:delete_item",
        businessId: businessId!,
        entityId: id,
        payload: { id },
      }),
    onMutate: (id) => {
      const prev = snapshot(CATALOG_KEYS.items(businessId));
      qc.setQueriesData({ queryKey: CATALOG_KEYS.items(businessId) }, (old) =>
        patchMenuRows(old, (rows) => removeMenuRow(rows, id)),
      );
      return { prev };
    },
    onError: (_error, _vars, ctx) =>
      restore((ctx as { prev?: QuerySnapshot } | undefined)?.prev),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CATALOG_KEYS.items(businessId) });
    },
  });
}
export function useToggleItemAvailabilityMutation() {
  const businessId = useBusinessId();
  const { qc, snapshot, restore } = useOptimisticMenuPatch();
  return useMutation({
    mutationFn: ({ id, available, cacheRecord }: { id: string; available: boolean; cacheRecord?: unknown }) =>
      commitMenuMutationLocal({
        commandType: "menu:update_item",
        businessId: businessId!,
        entityId: id,
        payload: cacheRecord ? { id, available, cacheRecord } : { id, available },
      }),
    onMutate: ({ id, available, cacheRecord }) => {
      const prev = snapshot(CATALOG_KEYS.items(businessId));
      const record =
        cacheRecord && typeof cacheRecord === "object"
          ? { ...(cacheRecord as object), id, available }
          : undefined;
      qc.setQueriesData({ queryKey: CATALOG_KEYS.items(businessId) }, (old) =>
        patchMenuRows(old, (rows) =>
          rows.map((row) =>
            recordId(row) === id
              ? record ?? { ...(row as object), available }
              : row,
          ),
        ),
      );
      return { prev };
    },
    onError: (_error, _vars, ctx) =>
      restore((ctx as { prev?: QuerySnapshot } | undefined)?.prev),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CATALOG_KEYS.items(businessId) });
    },
  });
}
export function useCreateMenuCategoryMutation() {
  const businessId = useBusinessId();
  const { qc, snapshot, restore } = useOptimisticMenuPatch();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      commitMenuMutationLocal({
        commandType: "menu:create_category",
        businessId: businessId!,
        entityId: (payload as { id?: string }).id,
        payload,
      }),
    onMutate: (payload) => {
      const record = (payload as { cacheRecord?: unknown }).cacheRecord;
      const prev = snapshot(CATALOG_KEYS.categories(businessId));
      if (record) {
        qc.setQueriesData({ queryKey: CATALOG_KEYS.categories(businessId) }, (old) =>
          patchMenuRows(old, (rows) => upsertMenuRow(rows, record)),
        );
      }
      return { prev };
    },
    onError: (_error, _vars, ctx) =>
      restore((ctx as { prev?: QuerySnapshot } | undefined)?.prev),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CATALOG_KEYS.categories(businessId) });
    },
  });
}
export function useUpdateMenuCategoryMutation() {
  const businessId = useBusinessId();
  const { qc, snapshot, restore } = useOptimisticMenuPatch();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      commitMenuMutationLocal({
        commandType: "menu:update_category",
        businessId: businessId!,
        entityId: id,
        payload: { ...payload, id },
      }),
    onMutate: ({ payload }) => {
      const record = (payload as { cacheRecord?: unknown }).cacheRecord;
      const prev = snapshot(CATALOG_KEYS.categories(businessId));
      if (record) {
        qc.setQueriesData({ queryKey: CATALOG_KEYS.categories(businessId) }, (old) =>
          patchMenuRows(old, (rows) => upsertMenuRow(rows, record)),
        );
      }
      return { prev };
    },
    onError: (_error, _vars, ctx) =>
      restore((ctx as { prev?: QuerySnapshot } | undefined)?.prev),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CATALOG_KEYS.categories(businessId) });
    },
  });
}
export function useDeleteMenuCategoryMutation() {
  const businessId = useBusinessId();
  const { qc, snapshot, restore } = useOptimisticMenuPatch();
  return useMutation({
    mutationFn: (id: string) =>
      commitMenuMutationLocal({
        commandType: "menu:delete_category",
        businessId: businessId!,
        entityId: id,
        payload: { id },
      }),
    onMutate: (id) => {
      const prev = snapshot(CATALOG_KEYS.categories(businessId));
      qc.setQueriesData({ queryKey: CATALOG_KEYS.categories(businessId) }, (old) =>
        patchMenuRows(old, (rows) => removeMenuRow(rows, id)),
      );
      return { prev };
    },
    onError: (_error, _vars, ctx) =>
      restore((ctx as { prev?: QuerySnapshot } | undefined)?.prev),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: CATALOG_KEYS.categories(businessId) });
    },
  });
}
