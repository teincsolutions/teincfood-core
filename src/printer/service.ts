/**
 * Printer service — fetch receipt from backend when online,
 * otherwise generate locally from SellerOrder snapshot (backend-identical template).
 * Sends ESC/POS via TcpSocketAdapter, falls back to PrintFileAdapter.
 */

import { getHttpClient } from "../adapters/http";
import { getTcpAdapter, getPrintFileAdapter } from "../adapters/print";
import { getPrinterState } from "./store";
import { generateEscpos, generateHtml } from "./receipt";
import type { SellerOrder } from "../types/api/seller.api";

async function fetchReceipt(orderId: string, format: "html" | "escpos" = "html"): Promise<string> {
  const http = getHttpClient();
  // http adapter wraps axios; fallback to fetch if not set
  if (http) {
    const res = await http.get<string>(`/orders/${orderId}/receipt?format=${format}`, {
      headers: { Accept: format === "html" ? "text/html" : "text/plain" },
    } as unknown as Record<string, unknown>);
    // http.get may return { data: string } or raw string; handle both
    const data = (res as unknown as { data?: string }).data ?? (res as unknown as string);
    if (typeof data === "string") return data;
    return String(data);
  }
  // Fallback fetch using API_BASE_URL already injected
  const { API_BASE_URL } = await import("../utils/constants");
  const url = `${API_BASE_URL}/orders/${orderId}/receipt?format=${format}`;
  const resp = await fetch(url, { headers: { Accept: format === "html" ? "text/html" : "text/plain" } });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Failed to fetch receipt (${resp.status}): ${body.slice(0, 200)}`);
  }
  return resp.text();
}

/**
 * Generate receipt locally without network — used for offline queued DD-RRR-CCC orders.
 */
export function generateLocalReceipt(order: SellerOrder, format: "html" | "escpos" = "escpos", logoDataUri?: string | null): string {
  return format === "escpos" ? generateEscpos(order) : generateHtml(order, logoDataUri);
}

/**
 * Print an order — tries TCP ESC/POS if a default printer is configured, otherwise
 * generates HTML and uses the PrintFileAdapter (expo-print / Tauri print).
 * `order` must be a full SellerOrder snapshot; for online orders we attempt to
 * fetch the authoritative receipt first so the business logo/address are server-rendered.
 */
export async function printOrderReceipt(order: SellerOrder, opts?: { logoDataUri?: string | null }): Promise<void> {
  const { autoPrint, printers, defaultPrinterId } = getPrinterState();
  const needsTcp = !!defaultPrinterId && autoPrint !== false;
  const printer = needsTcp ? printers.find((p) => p.id === defaultPrinterId) : null;
  const isTcp = !!(printer && printer.type === "tcp");

  // Try authoritative backend receipt first when online (includes logo data URI)
  // For offline/queued orders we generate locally.
  let escpos: string | null = null;
  let html: string | null = null;

  if (isTcp) {
    try {
      // Prefer backend escpos when we have a real UUID (not DD-RRR-CCC)
      const isLocal = /^[0-9]{2}-[0-9]{3}-[0-9]{3}$/.test(order.order_number) || /^[0-9A-F-]{36}$/.test(order.id) === false && order.id === order.order_number;
      if (!isLocal || order.id) {
        try {
          escpos = await fetchReceipt(order.id, "escpos");
        } catch {
          // fall back to local
        }
      }
      if (!escpos) escpos = generateLocalReceipt(order, "escpos", opts?.logoDataUri ?? null);
      const tcp = getTcpAdapter();
      if (!tcp) throw new Error("TCP adapter not configured");
      await tcp.sendToTcpPrinter(printer!.ip, printer!.port, escpos);
      return;
    } catch (e) {
      console.debug("[print] TCP print failed, falling back to HTML", e);
    }
  }

  // Fallback: HTML via PrintFileAdapter or local share
  try {
    try {
      html = await fetchReceipt(order.id, "html");
    } catch {
      // offline
    }
    if (!html) html = generateLocalReceipt(order, "html", opts?.logoDataUri ?? null);
    const printAdapter = getPrintFileAdapter();
    if (printAdapter) {
      const { uri } = await printAdapter.printToFileAsync(html);
      if (printAdapter.isSharingAvailable && printAdapter.shareAsync) {
        const available = await printAdapter.isSharingAvailable();
        if (available) await printAdapter.shareAsync(uri, { dialogTitle: "Print Receipt", mimeType: "application/pdf" });
      }
      return;
    }
    // No adapter — throw so host can show preview fallback
    throw new Error("PrintFileAdapter not configured — use generateLocalReceipt + WebView preview");
  } catch (e) {
    console.debug("[print] HTML print failed", e);
    throw e;
  }
}

export async function sendToTcpPrinter(ip: string, port: number, text: string): Promise<void> {
  const tcp = getTcpAdapter();
  if (!tcp) throw new Error("TCP socket not available");
  return tcp.sendToTcpPrinter(ip, port, text);
}

export const printerService = {
  fetchReceipt,
  generateLocalReceipt,
  printOrderReceipt,
  sendToTcpPrinter,
  generateEscpos,
  generateHtml,
};
