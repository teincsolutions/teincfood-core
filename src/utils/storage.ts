/**
 * Storage facade — re-exports KV adapter.
 * Provides async JSON helpers and a zustand-compatible storage shim.
 */

export {
  getItem,
  setItem,
  removeItem,
  kvGetItem,
  kvSetItem,
  kvRemoveItem,
  setKVDriver,
  getKVDriver,
} from "../adapters/kv";

import { kvGetItem, kvSetItem, kvRemoveItem } from "../adapters/kv";
import { getItemSync, setItemSync, removeItemSync } from "../adapters/kv";
import type { StateStorage } from "../adapters/kv-types";

// Keep mmkvStorage export for backwards compat (no-op)
export const mmkvStorage = {
  getString: (_key: string) => null as string | null,
  set: (_key: string, _value: string) => {},
  delete: (_key: string) => {},
};

export const zustandStorage: StateStorage = {
  getItem: (name: string) => {
    const v = getItemSync<string>(name);
    return v ? JSON.stringify(v) : null;
  },
  setItem: (name: string, value: string) => {
    try {
      setItemSync(name, JSON.parse(value));
    } catch {}
  },
  removeItem: (name: string) => {
    removeItemSync(name);
  },
};

// Async helpers for code that expects promise-based storage (used by order-number, etc.)
export async function getItemAsync<T>(key: string): Promise<T | null> {
  const raw = await kvGetItem(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setItemAsync<T>(key: string, value: T): Promise<void> {
  await kvSetItem(key, JSON.stringify(value));
}

export async function removeItemAsync(key: string): Promise<void> {
  await kvRemoveItem(key);
}
