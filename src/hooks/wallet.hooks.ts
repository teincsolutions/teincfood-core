/**
 * Wallet hooks — offline-first. Balances and history serve the persisted
 * query cache instantly offline; the network refreshes silently when online.
 * (No SQLite wallet cache — the persisted TanStack cache is the offline
 * source; both apps persist it.)
 */

import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { getActiveBusiness, subscribeBusiness } from "../adapters/business";
import { walletService } from "../adapters/services";
import type { WalletBalanceResponse, WalletHistoryResponse, WalletEntry } from "../types/api/wallet.api";
import { useInfiniteList, useIsEffectivelyOnline } from "./use-infinite-list";

export const WALLET_KEYS = {
  all: ["wallet"] as const,
  balance: (scope?: string) => [...WALLET_KEYS.all, "balance", scope] as const,
  history: (scope?: string) => [...WALLET_KEYS.all, "history", scope] as const,
};

function useBusinessId(): string | undefined {
  const id = useSyncExternalStore(subscribeBusiness, () => getActiveBusiness()?.id ?? null, () => null);
  return id ?? undefined;
}

export function useAllBalancesQuery(enabled = true) {
  // No SQLite mirror — the persisted query cache is the offline source.
  // Never fire while unreachable; the OfflineBanner marks data not-live.
  const online = useIsEffectivelyOnline();
  return useQuery({
    queryKey: WALLET_KEYS.balance("all"),
    queryFn: () => walletService.fetchAllBalances() as Promise<WalletBalanceResponse>,
    enabled: enabled && online,
    staleTime: 30_000,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

export function useBusinessWalletBalanceQuery(enabled = true) {
  const businessId = useBusinessId();
  // No SQLite mirror — the persisted query cache is the offline source.
  // Never fire while unreachable; the OfflineBanner marks data not-live.
  const online = useIsEffectivelyOnline();
  return useQuery({
    queryKey: WALLET_KEYS.balance(businessId),
    queryFn: () => walletService.fetchBusinessWalletBalance(businessId!) as Promise<WalletBalanceResponse>,
    enabled: enabled && Boolean(businessId) && online,
    staleTime: 30_000,
    retry: false,
    networkMode: "offlineFirst" as const,
  });
}

export function useWalletHistoryQuery(enabled = true) {
  const businessId = useBusinessId();
  return useInfiniteList<WalletEntry>({
    key: [...WALLET_KEYS.history(businessId)],
    enabled: enabled && Boolean(businessId),
    pageSize: 20,
    staleTime: 30_000,
    onlineFetch: async (page, pageSize) => {
      const res = (await walletService.fetchWalletHistory({ businessId, page, pageSize })) as WalletHistoryResponse;
      return { data: res.data.entries, pagination: res.pagination };
    },
  });
}
