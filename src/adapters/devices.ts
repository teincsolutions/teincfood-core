/**
 * Devices service — stable per-device UUID for DD lease.
 * Persists via KV sync so DD stays same for life of device (until wipe).
 */

import { getItemSync, setItemSync, getItem, setItem } from "./kv";
import { generateUUID } from "../utils/uuid";

let appInstanceId: string | null = null;
const APP_ID_KEY = "teinc_app_instance_id";

export interface DeviceMetadata {
  deviceName?: string | null;
  platform?: string | null;
  osVersion?: string | null;
  appVersion?: string | null;
}

let deviceMetadataProvider: (() => Promise<DeviceMetadata> | DeviceMetadata) | null = null;

/** Host apps inject OS/device details so licenses and admin dashboards can identify terminals. */
export function setDeviceMetadataProvider(
  provider: (() => Promise<DeviceMetadata> | DeviceMetadata) | null,
): void {
  deviceMetadataProvider = provider;
}

export async function getDeviceMetadata(): Promise<DeviceMetadata> {
  if (!deviceMetadataProvider) return {};
  try {
    return await deviceMetadataProvider();
  } catch {
    return {};
  }
}

// For Tauri desktop, try to restore from localStorage synchronously at import to avoid async race generating a new UUID on every cargo tauri dev restart
try {
  if (typeof localStorage !== "undefined") {
    const ls = localStorage.getItem(APP_ID_KEY);
    if (ls) {
      let v: string = ls;
      try { if (v.startsWith('"')) v = JSON.parse(v) as string; } catch {}
      try { if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v) as string; } catch {}
      if (v.length > 8) appInstanceId = v;
    }
  }
} catch {}

export function setAppInstanceId(id: string): void {
  appInstanceId = id;
  try { setItemSync(APP_ID_KEY, id); } catch {}
}

export function getAppInstanceId(): string {
  if (appInstanceId) return appInstanceId;
  // Check localStorage first (covers Tauri webview where KVDriver async may race)
  try {
    const ls = typeof localStorage !== "undefined" ? localStorage.getItem(APP_ID_KEY) : null;
    if (ls) {
      let v: string = ls;
      try { if (v.startsWith('"')) v = JSON.parse(v) as string; } catch {}
      try { if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v) as string; } catch {}
      if (v.length > 8) { appInstanceId = v; return v; }
    }
  } catch {}
  try {
    const stored = getItemSync<string>(APP_ID_KEY);
    if (stored && typeof stored === "string" && stored.length > 8) {
      let v: string = stored;
      try { if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v) as string; } catch {}
      if (v.length > 8) {
        appInstanceId = v;
        try { if (typeof localStorage !== "undefined") localStorage.setItem(APP_ID_KEY, JSON.stringify(v)); } catch {}
        return v;
      }
    }
  } catch {}
  const id = generateUUID();
  appInstanceId = id;
  try { setItemSync(APP_ID_KEY, id); } catch {}
  try { if (typeof localStorage !== "undefined") localStorage.setItem(APP_ID_KEY, JSON.stringify(id)); } catch {}
  return id;
}

export async function getAppInstanceIdAsync(): Promise<string> {
  if (appInstanceId) return appInstanceId;
  // Try localStorage directly first (covers desktop webview where KVDriver's async getItem may race with Tauri store load)
  try {
    const ls = typeof localStorage !== "undefined" ? localStorage.getItem(APP_ID_KEY) : null;
    if (ls) {
      let v: string = ls;
      try { if (v.startsWith('"')) v = JSON.parse(v) as string; } catch {}
      // Handle double-stringified "\"xxx\""
      try { if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v) as string; } catch {}
      if (v.length > 8) { appInstanceId = v; return v; }
    }
  } catch {}
  try {
    const stored = await getItem<string>(APP_ID_KEY);
    try { const { syncLogger } = require("../utils/sync-logger"); syncLogger.debug("Devices", "getAppInstanceIdAsync getItem", { stored, len: stored?.length }); } catch {}
    if (stored && typeof stored === "string" && stored.length > 8) {
      // Handle double-stringified case "\"xxx\"" from older builds
      let v: string = stored;
      try { if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v) as string; } catch {}
      if (v.length > 8) { appInstanceId = v; // also prime localStorage for sync fallback
        try { if (typeof localStorage !== "undefined") localStorage.setItem(APP_ID_KEY, JSON.stringify(v)); } catch {} return v; }
    }
  } catch {}
  // fallback to sync check
  try {
    const s = getItemSync<string>(APP_ID_KEY);
    try { const { syncLogger } = require("../utils/sync-logger"); syncLogger.debug("Devices", "getAppInstanceIdAsync getItemSync", { s, len: s?.length }); } catch {}
    if (s && typeof s === "string" && s.length > 8) {
      let v: string = s;
      try { if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v) as string; } catch {}
      if (v.length > 8) { appInstanceId = v; return v; }
    }
  } catch {}
  const id = generateUUID();
  appInstanceId = id;
  try { const { syncLogger } = require("../utils/sync-logger"); syncLogger.info("Devices", "generated new appInstanceId", { id }); } catch {}
  try { await setItem(APP_ID_KEY, id); } catch { try { setItemSync(APP_ID_KEY, id); } catch {} }
  try { if (typeof localStorage !== "undefined") localStorage.setItem(APP_ID_KEY, JSON.stringify(id)); } catch {}
  return id;
}
