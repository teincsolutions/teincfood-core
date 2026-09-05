/**
 * Devices service — stable per-device UUID for DD lease.
 * Persists via KV sync so DD stays same for life of device (until wipe).
 */

import { getItemSync, setItemSync, getItem, setItem } from "./kv";
import { generateUUID } from "../utils/uuid";

let appInstanceId: string | null = null;
const APP_ID_KEY = "teinc_app_instance_id";

export function setAppInstanceId(id: string): void {
  appInstanceId = id;
  try { setItemSync(APP_ID_KEY, id); } catch {}
}

export function getAppInstanceId(): string {
  if (appInstanceId) return appInstanceId;
  try {
    const stored = getItemSync<string>(APP_ID_KEY);
    if (stored && typeof stored === "string" && stored.length > 8) {
      appInstanceId = stored;
      return stored;
    }
  } catch {}
  const id = generateUUID();
  appInstanceId = id;
  try { setItemSync(APP_ID_KEY, id); } catch {}
  return id;
}

export async function getAppInstanceIdAsync(): Promise<string> {
  if (appInstanceId) return appInstanceId;
  try {
    const stored = await getItem<string>(APP_ID_KEY);
    if (stored && typeof stored === "string" && stored.length > 8) {
      appInstanceId = stored;
      return stored;
    }
  } catch {}
  // fallback to sync check
  try {
    const s = getItemSync<string>(APP_ID_KEY);
    if (s && typeof s === "string" && s.length > 8) {
      appInstanceId = s;
      return s;
    }
  } catch {}
  const id = generateUUID();
  appInstanceId = id;
  try { await setItem(APP_ID_KEY, id); } catch { try { setItemSync(APP_ID_KEY, id); } catch {} }
  return id;
}
