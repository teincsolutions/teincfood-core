import type { PaginationMeta } from './pagination';

export interface WalletBalanceItem {
  type: 'buyer' | 'business' | 'rider';
  amount_minor: number;
  currency: string;
  business_id?: string;
}

export interface WalletBalanceResponse {
  data: {
    balances: WalletBalanceItem[];
  };
}

export interface WalletEntry {
  id: string;
  type: string;
  amount_minor: number;
  currency: string;
  balance_after: number;
  description: string | null;
  inserted_at: string;
}

export interface WalletHistoryResponse {
  data: {
    entries: WalletEntry[];
  };
  pagination: PaginationMeta;
}
