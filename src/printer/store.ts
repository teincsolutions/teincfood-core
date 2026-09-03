/**
 * Printer store — local device config, persisted via KV driver.
 * Business app invariant: printers are device-local, never cleared on logout.
 */

import { getKVDriver } from "../adapters/kv";
import { STORAGE_KEYS } from "../utils/constants";
import type { PrinterConfig, PrinterState } from "./types";

const listeners = new Set<() => void>();

let state: PrinterState = {
  defaultPrinterId: null,
  printers: [],
  autoPrint: false,
};

let hydrated = false;

function notify(): void {
  listeners.forEach((l) => l());
}

async function persist(): Promise<void> {
  try {
    const kv = getKVDriver();
    await kv.setItem(STORAGE_KEYS.PRINTER_SETTINGS, JSON.stringify(state));
  } catch {}
}

export async function hydratePrinterStore(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const kv = getKVDriver();
    const raw = await kv.getItem(STORAGE_KEYS.PRINTER_SETTINGS);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PrinterState>;
      state = {
        defaultPrinterId: parsed.defaultPrinterId ?? null,
        printers: Array.isArray(parsed.printers) ? parsed.printers : [],
        autoPrint: !!parsed.autoPrint,
      };
      notify();
    }
  } catch {}
}

export function getPrinterState(): PrinterState {
  return state;
}

export function subscribePrinter(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPrinterSnapshot(): PrinterState {
  return state;
}

export function setDefaultPrinter(id: string | null): void {
  state = { ...state, defaultPrinterId: id };
  notify();
  void persist();
}

export function addPrinter(printer: PrinterConfig): void {
  state = { ...state, printers: [...state.printers, printer] };
  notify();
  void persist();
}

export function updatePrinter(id: string, updates: Partial<PrinterConfig>): void {
  state = {
    ...state,
    printers: state.printers.map((p) => (p.id === id ? { ...p, ...updates } : p)),
  };
  notify();
  void persist();
}

export function removePrinter(id: string): void {
  state = {
    ...state,
    printers: state.printers.filter((p) => p.id !== id),
    defaultPrinterId: state.defaultPrinterId === id ? null : state.defaultPrinterId,
  };
  notify();
  void persist();
}

export function setAutoPrint(enabled: boolean): void {
  state = { ...state, autoPrint: enabled };
  notify();
  void persist();
}

export const printerStore = {
  getState: getPrinterState,
  subscribe: subscribePrinter,
  hydrate: hydratePrinterStore,
  setDefaultPrinter,
  addPrinter,
  updatePrinter,
  removePrinter,
  setAutoPrint,
};
