/**
 * KV storage adapter — async get/set/remove with in-memory fallback for tests.
 * Host apps can inject a persistent backend via setKVDriver().
 */

export interface KVDriver {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

const memory = new Map<string, string>();
let driver: KVDriver | null = null;

export function setKVDriver(d: KVDriver): void {
  driver = d;
}

export function getKVDriver(): KVDriver {
  if (driver) return driver;
  return {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  };
}

export async function kvGetItem(key: string): Promise<string | null> {
  const v = await getKVDriver().getItem(key);
  return v ?? null;
}

export async function kvSetItem(key: string, value: string): Promise<void> {
  await getKVDriver().setItem(key, value);
}

export async function kvRemoveItem(key: string): Promise<void> {
  await getKVDriver().removeItem(key);
}

// Typed JSON helpers (mirrors old storage.ts sync API but async)
export async function getItem<T>(key: string): Promise<T | null> {
  const raw = await kvGetItem(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setItem<T>(key: string, value: T): Promise<void> {
  await kvSetItem(key, JSON.stringify(value));
}

export async function removeItem(key: string): Promise<void> {
  await kvRemoveItem(key);
}

// Synchronous fallbacks for legacy callers that used MMKV sync API
// 0.7.1: delegate to driver when driver supports sync (MMKV), otherwise memory
export function getItemSync<T>(key: string): T | null {
  let raw: string | null | undefined;
  if (driver) {
    try {
      const v = driver.getItem(key);
      // if driver returns Promise, we can't await sync — fall back to memory
      if (v instanceof Promise) raw = memory.get(key) ?? null;
      else raw = (v as string | null) ?? memory.get(key) ?? null;
    } catch {
      raw = memory.get(key) ?? null;
    }
  } else {
    raw = memory.get(key);
  }
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function setItemSync<T>(key: string, value: T): void {
  const str = JSON.stringify(value);
  memory.set(key, str);
  if (driver) {
    try {
      const r = driver.setItem(key, str);
      // if async, also keep memory
      if (r instanceof Promise) r.catch(() => {});
    } catch {}
  }
}

export function removeItemSync(key: string): void {
  memory.delete(key);
  if (driver) {
    try {
      const r = driver.removeItem(key);
      if (r instanceof Promise) r.catch(() => {});
    } catch {}
  }
}
