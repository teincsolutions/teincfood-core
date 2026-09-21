/**
 * Local receipt generation — implements docs/receipt-template.md
 * (single source of design; backend TeincFoodBackend.Orders.Receipt
 * implements the same spec). Generates ESC/POS (80mm, 32 chars) and HTML
 * (visual twin) from a SellerOrder snapshot. Works fully offline.
 */

import type { SellerOrder, OrderItem, OrderItemAddon } from "../types/api/seller.api";
import { openSyncDatabase } from "../db/connection";
import { getReferenceData } from "../reference/operations";
import { cacheRemoteImage, resolveImageSource } from "../image-cache/service";

const LINE_WIDTH = 32;

const ESC_INIT = "\x1B\x40";
const ESC_ALIGN_LEFT = "\x1B\x61\x00";
const ESC_ALIGN_CENTER = "\x1B\x61\x01";
const ESC_BOLD_ON = "\x1B\x45\x01";
const ESC_BOLD_OFF = "\x1B\x45\x00";
const GS_SIZE_NORMAL = "\x1D\x21\x00";
const GS_SIZE_DOUBLE_W = "\x1D\x21\x11";
const GS_BAR_HEIGHT = "\x1D\x68\x3C";
const GS_BAR_WIDTH = "\x1D\x77\x02";
const LF = "\x0A";
const ESC_FEED_3 = "\x1B\x64\x03";
const GS_CUT_FULL = "\x1D\x56\x00";

/**
 * Thermal printers speak bytes, not Unicode. Control sequences are pushed
 * raw, but every human-readable text segment must pass through here first:
 * known symbols map to ASCII, anything else non-ASCII becomes "?".
 * Without this, ₵/═/─/accents print as gibberish (UTF-8 bytes read as CP437).
 */
const ESCPOS_REPLACEMENTS: Array<[RegExp, string]> = [
  [/[₵]/g, "GHc"],
  [/[€]/g, "EUR"],
  [/[£]/g, "GBP"],
  [/[—–]/g, "-"],
  [/[•·]/g, "*"],
  [/[═╬]/g, "="],
  [/[─│]/g, "-"],
  [/[“”]/g, '"'],
  [/[‘’`]/g, "'"],
  [/[…]/g, "..."],
  [/[×]/g, "x"],
  [/[°]/g, "deg"],
  [/ /g, " "],
];

export function escposText(s: string | null | undefined): string {
  if (s == null) return "";
  let out = String(s);
  for (const [re, sub] of ESCPOS_REPLACEMENTS) out = out.replace(re, sub);
  // Strip any remaining non-ASCII (accents, emoji, CJK) — the printer cannot
  // render them and would print garbage bytes.
  out = out.replace(/[^\x20-\x7E\n]/g, "?");
  return out;
}

function padR(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  return text.padEnd(width, " ");
}

function padL(text: string | number, width: number): string {
  const s = String(text);
  if (s.length >= width) return s.slice(0, width);
  return s.padStart(width, " ");
}

/** Word-wrap sanitized text to width. Long words hard-split. Never drops content. */
export function wrapText(text: string, width: number): string[] {
  const words: string[] = [];
  for (const word of text.split(" ").filter(Boolean)) {
    if (word.length <= width) words.push(word);
    else for (let i = 0; i < word.length; i += width) words.push(word.slice(i, i + width));
  }
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += " " + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Business-name fit ladder (centered, never truncated):
 * ≤16 chars → 2x, 17–64 → 1x bold (≤2 lines), longer → 1x (≤3 lines,
 * keeps wrapping beyond that).
 */
function nameBlockEscpos(name: string): string[] {
  const text = escposText(name);
  if (text.length <= 16) return [GS_SIZE_DOUBLE_W, text, LF, GS_SIZE_NORMAL];
  if (text.length <= 64) {
    return [ESC_BOLD_ON, ...wrapText(text, 32).flatMap((l) => [escposText(l), LF]), ESC_BOLD_OFF];
  }
  return wrapText(text, 32).flatMap((l) => [escposText(l), LF]);
}

function nameSizeClass(name: string | null | undefined): string {
  const len = (name || "").length;
  if (len <= 16) return "name-2x";
  if (len <= 64) return "name-1x-bold";
  return "name-1x";
}

function currencySymbol(currency?: string | null): string {
  switch (currency) {
    case "GHS": return "₵";
    case "USD": return "$";
    case "EUR": return "€";
    case "GBP": return "£";
    default: return currency ? currency + " " : "";
  }
}

function formatMoney(amountMinor: number | null | undefined, order: SellerOrder): string {
  if (amountMinor == null) return "---";
  const sym = currencySymbol(order.currency_code || order.currency);
  return `${sym}${(amountMinor / 100).toFixed(2)}`;
}

function formatDatetime(iso?: string | null): string {
  if (!iso) return "---";
  try {
    const d = new Date(iso);
    // Backend: Calendar.strftime(dt, "%d %b %Y %H:%M") e.g. "03 Sep 2026 14:05"
    const day = String(d.getDate()).padStart(2, "0");
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const mon = months[d.getMonth()];
    const year = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${day} ${mon} ${year} ${hh}:${mm}`;
  } catch { return iso; }
}

export function calloutNumber(order: SellerOrder): string {
  // The backend assigns a real callout_number — always prefer it.
  const direct = (order as unknown as { callout_number?: unknown }).callout_number;
  if (typeof direct === "number" && Number.isFinite(direct)) return String(Math.abs(direct));
  const num = order.order_number || "";
  if (!num) return "----";
  // Strip non-digits first: local DD-RRR-CCC numbers end in "-CCC" and
  // parseInt("-005") would give -5 (the old "-5" bug).
  const digits = num.slice(-4).replace(/\D/g, "");
  if (!digits) return num.slice(-4);
  return String(parseInt(digits, 10));
}

function itemName(item: OrderItem): string {
  return item.menu_item?.name || "(deleted item)";
}

function addonName(addon: OrderItemAddon): string {
  if (addon.addon?.name) return addon.addon.name;
  if (addon.name) return addon.name;
  return "Add-on";
}

function variantName(item: OrderItem): string | null {
  const n = item.variant?.name;
  return n ? n : null;
}

function orderTypeText(order: SellerOrder): string {
  const t = order.order_type as string | null;
  if (t === "takeout") return "Takeout";
  if (t === "dine_in") return "Dine-in";
  if (t === "delivery") return "Delivery";
  if (order.payment_mode === "pay_on_delivery") return "Pay on Delivery";
  if (order.payment_mode === "prepaid") return "Prepaid";
  return "Walk-in";
}

function paymentLineText(order: SellerOrder): string {
  const m = order.pos_payment_method as string | null;
  if (m) return `Payment: ${m.charAt(0).toUpperCase() + m.slice(1)}`;
  if (order.payment_mode === "pay_on_delivery") return "Payment: Cash / Pay on Delivery";
  if (order.payment_mode === "prepaid") return "Payment: Prepaid (Online)";
  return "Payment: Walk-in";
}

function escHtml(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function businessAddress(business: SellerOrder["business"]): string | null {
  const b = business as unknown as {
    location?: { address?: string };
    address?: string | { fullAddress?: string; full_address?: string; street?: string; city?: string };
  } | null;
  if (!b) return null;
  if (b.location?.address) return b.location.address;
  if (typeof b.address === "string") return b.address;
  // Desktop snapshots carry a structured address object — flatten it
  // (printing the object itself would render "[object Object]").
  if (b.address && typeof b.address === "object") {
    if (b.address.fullAddress) return b.address.fullAddress;
    if (b.address.full_address) return b.address.full_address;
    const parts = [b.address.street, b.address.city].filter(Boolean);
    if (parts.length) return parts.join(", ");
  }
  return null;
}

function businessLogoUrl(order: SellerOrder): string | null {
  const b = order.business as unknown as { logo_url?: string | null; logoUrl?: string | null } | null;
  if (!b) return null;
  return (b.logo_url ?? (b as unknown as { logoUrl?: string | null }).logoUrl ?? null) as string | null;
}

/** Fetch remote URL (or tfimg://) and return data URI, or null on failure. Uses Web fetch; works for http(s) and for cached tfimg via Rust protocol. */
async function fetchAsDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const reader = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.onerror = () => reject(new Error("FileReader failed"));
      fr.readAsDataURL(blob);
    });
    return reader;
  } catch { return null; }
}

/** Decode base64 raster bytes (from `business:profile` reference) to a byte string. */
function binaryFromBase64(b64: string): string {
  const clean = b64.replace(/\s/g, "");
  if (typeof atob === "function") return atob(clean);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    if (ch === "=") break;
    const v = chars.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buf >> bits) & 0xff);
    }
  }
  if (!out) throw new Error("empty raster");
  return out;
}

/**
 * Resolve cached logo raster (base64 `GS v 0` block) for an order: prefers
 * `order.business.logo_escpos`, falls back to the synced `business:profile`
 * reference. Null when none — fully offline, no network.
 */
export async function resolveLogoRaster(order: SellerOrder): Promise<string | null> {
  const direct = (order.business as unknown as { logo_escpos?: unknown } | null)?.logo_escpos;
  if (typeof direct === "string" && direct.length > 0) return direct;
  try {
    const bId = order.business_id;
    if (!bId) return null;
    const db = await openSyncDatabase();
    const ref = await getReferenceData<{ data?: { logo_escpos?: unknown } }>(
      db, bId, "business:profile" as unknown as import("../reference/types").ReferenceDataKey,
    );
    const raster = (ref?.payload as unknown as { data?: { logo_escpos?: unknown } })?.data?.logo_escpos;
    return typeof raster === "string" && raster.length > 0 ? raster : null;
  } catch { return null; }
}

// ── ESC/POS ────────────────────────────────────────────────────────────

function doubleLineEscpos(): string { return "═".repeat(LINE_WIDTH) + LF; }
function singleLineEscpos(): string { return "─".repeat(LINE_WIDTH); }

function customerLineEscpos(order: SellerOrder): string | null {
  if (order.customer_name) return `Customer: ${order.customer_name}${LF}`;
  if (order.customer_phone) return `Phone: ${order.customer_phone}${LF}`;
  if (order.user?.full_name) return `Customer: ${order.user.full_name}${LF}`;
  return null;
}

function orderTypeEscpos(order: SellerOrder): string { return orderTypeText(order); }
function paymentLineEscpos(order: SellerOrder): string { return paymentLineText(order); }

export function generateEscpos(order: SellerOrder, logoRasterB64?: string | null): string {
  const business = order.business;
  const items = order.items || [];
  const taxLines = ((order as unknown as { order_tax_lines?: SellerOrder["tax_lines"] }).order_tax_lines ?? order.tax_lines ?? []) as SellerOrder["tax_lines"];
  const parts: (string | null)[] = [];

  const push = (s: string | null | undefined) => { if (s != null) parts.push(s); };
  // Sanitized text push: every human-readable segment goes through escposText
  // (control codes and barcode data use raw push).
  const pushT = (s: string | null | undefined) => { if (s != null) parts.push(escposText(s)); };

  // Header — implements docs/receipt-template.md §1
  // NOTE: no logo in ESC/POS text mode — a logo URL cannot be rendered without
  // a raster pipeline (GS v 0). HTML receipts embed the logo instead.
  push(ESC_INIT);
  if (logoRasterB64) {
    try {
      push(binaryFromBase64(logoRasterB64));
    } catch { /* logo is decorative — never fail the receipt */ }
  }
  push(ESC_ALIGN_CENTER);
  for (const part of nameBlockEscpos(business?.name || "Teinc Food")) push(part);
  const addr = businessAddress(business);
  if (addr) pushT(addr + LF);
  const bPhone = (business as unknown as { phone?: string } | null)?.phone;
  if (bPhone) pushT(`Tel: ${bPhone}${LF}`);
  push(GS_SIZE_NORMAL);
  pushT(doubleLineEscpos());
  // Order info
  push(ESC_ALIGN_LEFT);
  pushT(`Order: ${order.order_number}${LF}`);
  // callout_box_escpos — symmetric blank lines, no border rules around it
  push(LF);
  push(ESC_ALIGN_CENTER);
  push(GS_SIZE_DOUBLE_W);
  pushT(`Callout: ${calloutNumber(order)}${LF}`);
  push(GS_SIZE_NORMAL);
  push(LF);
  push(ESC_ALIGN_LEFT);
  pushT(`Date: ${formatDatetime(order.inserted_at)}${LF}`);
  pushT(`Type: ${orderTypeEscpos(order)}${LF}`);
  const custLine = customerLineEscpos(order);
  if (custLine) pushT(custLine);
  push(LF);
  // Barcode — CODE128 GS k 73, sized down (default height is huge).
  push(ESC_ALIGN_CENTER);
  push(GS_BAR_HEIGHT);
  push(GS_BAR_WIDTH);
  const data = order.order_number || "";
  push(String.fromCharCode(0x1d, 0x6b, 0x49, data.length) + data);
  push(LF);
  // Items — template §2: name 17 | qty 3 (right) | price 10 (right) = 32
  push(ESC_ALIGN_LEFT);
  push(`${padR("Item", 17)} ${padL("Qty", 3)} ${padL("Price", 10)}`);
  push(LF);
  pushT(singleLineEscpos());
  push(LF);
  for (const item of items) {
    const qty = item.quantity || 1;
    const price = escposText(formatMoney((item.unit_price ?? 0) * qty, order));
    const nameLines = wrapText(escposText(itemName(item)), 17);
    const first = nameLines[0] ?? "(deleted item)";
    const rest = nameLines.slice(1, 2);
    pushT(`${padR(first, 17)} ${padL(qty, 3)} ${padL(price, 10)}${LF}`);
    for (const cont of rest) pushT(`${padR(cont, 17)}${LF}`);
    const vName = variantName(item);
    if (vName) {
      for (const vl of wrapText(escposText(`Size: ${vName}`), 30)) pushT(`  ${vl}${LF}`);
    }
    const addons = item.order_item_addons ?? item.addons ?? [];
    for (const addon of addons) {
      const aPriceMinor = addon.price_minor ?? addon.price ?? 0;
      const addonPrice = escposText(formatMoney(aPriceMinor, order));
      const aLines = wrapText(escposText(addonName(addon)), 17);
      if (!aLines.length) continue;
      pushT(`  + ${padR(aLines[0], 17)} ${padL(addonPrice, 10)}${LF}`);
      for (const aCont of aLines.slice(1, 2)) pushT(`      ${padR(aCont, 17)}${LF}`);
    }
  }
  pushT(singleLineEscpos());
  push(LF);
  // Subtotal section — template §3: label 20 + amount 11 (right)
  pushT(`${padR("Subtotal:", 20)} ${padL(escposText(formatMoney(order.subtotal_minor, order)), 11)}${LF}`);
  if (order.delivery_fee_minor && order.delivery_fee_minor > 0) {
    pushT(`${padR("Delivery Fee:", 20)} ${padL(escposText(formatMoney(order.delivery_fee_minor, order)), 11)}${LF}`);
  }
  for (const tax of taxLines as SellerOrder["tax_lines"]) {
    const rateStr = tax.rate_basis_points ? `(${Math.floor(tax.rate_basis_points / 100)}%)` : "";
    const label = `${tax.name || ""} ${rateStr}`.trim().slice(0, 19);
    pushT(`${padR(label, 20)} ${padL(escposText(formatMoney((tax as { tax_amount_minor?: number }).tax_amount_minor as number, order)), 11)}${LF}`);
  }
  if (order.discount_minor && order.discount_minor > 0) {
    pushT(`${padR("Discount:", 20)} ${padL("-" + escposText(formatMoney(order.discount_minor, order)), 11)}${LF}`);
  }
  push(LF);
  push(ESC_BOLD_ON);
  pushT(`${padR("TOTAL:", 20)} ${padL(escposText(formatMoney(order.total_minor, order)), 11)}${LF}`);
  push(ESC_BOLD_OFF);
  push(LF);
  push(ESC_ALIGN_CENTER);
  pushT(paymentLineEscpos(order));
  push(LF);
  // Footer
  pushT(doubleLineEscpos());
  push("Thank you for your order!" + LF);
  push("Come back soon!" + LF);
  push(ESC_FEED_3);
  push(GS_CUT_FULL);

  return parts.filter((p): p is string => p != null).join("");
}

// ── HTML ───────────────────────────────────────────────────────────────

export async function generateHtmlAsync(order: SellerOrder, opts?: { logoDataUri?: string | null; useCache?: boolean }): Promise<string> {
  const explicit = opts?.logoDataUri;
  if (explicit) return generateHtml(order, explicit);
  const logoUrl = businessLogoUrl(order);
  if (!logoUrl) {
    try {
      const bId = order.business_id;
      if (bId) {
        const db = await openSyncDatabase();
        const ref = await getReferenceData<{ data?: { logo_url?: string | null } }>(db, bId, "business:profile" as unknown as import("../reference/types").ReferenceDataKey);
        const refLogo = (ref?.payload as unknown as { data?: { logo_url?: string | null } })?.data?.logo_url;
        if (refLogo) {
          const dataUri = await fetchAsDataUri(refLogo);
          if (dataUri) return generateHtml(order, dataUri);
          try {
            await cacheRemoteImage(refLogo, { skipIfCached: true });
            const resolved = await resolveImageSource(refLogo);
            const src = resolved?.uri ?? refLogo;
            const dataUri2 = await fetchAsDataUri(src);
            if (dataUri2) return generateHtml(order, dataUri2);
            if (src !== refLogo) return generateHtml(order, src);
          } catch {}
          return generateHtml(order, refLogo);
        }
      }
    } catch {}
    return generateHtml(order, null);
  }
  try {
    await cacheRemoteImage(logoUrl, { skipIfCached: true });
    const resolved = await resolveImageSource(logoUrl);
    const src = resolved?.uri ?? logoUrl;
    const dataUri = await fetchAsDataUri(src);
    if (dataUri) return generateHtml(order, dataUri);
    if (src !== logoUrl) return generateHtml(order, src);
  } catch {}
  return generateHtml(order, logoUrl);
}

export function generateHtml(order: SellerOrder, logoDataUri?: string | null): string {
  const business = order.business;
  const items = order.items || [];
  const taxLines = (((order as unknown as { order_tax_lines?: SellerOrder["tax_lines"] }).order_tax_lines) ?? order.tax_lines ?? []) as SellerOrder["tax_lines"];
  const callout = calloutNumber(order);
  const logoSrc = logoDataUri || (business as unknown as { logo_url?: string } | null)?.logo_url || "";
  const hasLogo = !!logoSrc;
  const businessName = escHtml(business?.name || "Teinc Food");
  const addr = businessAddress(business);
  const bPhone = (business as unknown as { phone?: string } | null)?.phone;

  const itemRows = items.map((item) => {
    const qty = item.quantity || 1;
    // unit_price is already minor? backend format_money expects minor
    const price = formatMoney((item.unit_price ?? 0) * qty, order);
    const main = `<tr><td class="item-name">${escHtml(itemName(item))}</td><td class="item-qty">${qty}</td><td class="item-price">${price}</td></tr>`;
    const vName = variantName(item);
    const variantRow = vName
      ? `<tr class="variant-row"><td class="item-name" colspan="2">Size: ${escHtml(vName)}</td><td class="item-price"></td></tr>`
      : "";
    const addons = item.order_item_addons ?? item.addons ?? [];
    const addonRows = addons.map((addon) => {
      const aName = escHtml(addonName(addon));
      const aPriceMinor = addon.price_minor ?? addon.price ?? 0;
      return `<tr class="addon-row"><td class="item-name">+ ${aName}</td><td class="item-qty"></td><td class="addon-price">${formatMoney(aPriceMinor, order)}</td></tr>`;
    }).join("\n");
    return [main, variantRow, addonRows].filter(Boolean).join("\n");
  }).join("\n");

  const taxRowsHtml = (taxLines as SellerOrder["tax_lines"]).map((tax) => {
    const rateStr = tax.rate_basis_points ? `(${Math.floor(tax.rate_basis_points / 100)}%)` : "";
    return `<tr><td class="label">${escHtml(tax.name || "")} ${escHtml(rateStr)}</td><td class="amount">${formatMoney((tax as { tax_amount_minor?: number }).tax_amount_minor as number, order)}</td></tr>`;
  }).join("\n");

  // Exact style from receipt.ex to_html/2
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:monospace;max-width:320px;margin:0 auto;padding:16px;background:#fff;color:#111;}
  .header{text-align:center;border-top:2px solid #333;border-bottom:2px solid #333;padding:8px 0;margin-bottom:12px;}
  .header .logo{max-width:200px;max-height:64px;margin:4px auto;display:block;object-fit:contain;}
  .header h2{margin:4px 0 0;}
  .header h2.name-2x{font-size:28px;font-weight:bold;}
  .header h2.name-1x-bold{font-size:16px;font-weight:bold;}
  .header h2.name-1x{font-size:14px;}
  .header .address{font-size:11px;color:#555;margin:2px 0;}
  .callout{text-align:center;margin:16px 0;}
  .callout .number{font-size:36px;font-weight:bold;letter-spacing:4px;margin:0;}
  .callout .label{font-size:10px;color:#555;margin:0;}
  .order-info{font-size:12px;margin:8px 0;}
  table{width:100%;font-size:12px;border-collapse:collapse;table-layout:fixed;}
  td{padding:2px 0;vertical-align:top;overflow-wrap:anywhere;}
  .item-name{width:17ch;}
  .item-qty{width:3ch;text-align:right;}
  .item-price{width:10ch;text-align:right;}
  .addon-row td{font-size:11px;color:#666;padding-left:12px;}
  .addon-row td.addon-price{text-align:right;}
  .variant-row td{font-size:11px;color:#444;padding-left:8px;}
  .totals{margin-top:8px;}
  .totals td.label{text-align:left;width:70%;}
  .totals td.amount{text-align:right;width:30%;}
  .total-row td{padding-top:12px;}
  .total-row{font-weight:bold;font-size:15px;border-top:2px solid #333;border-bottom:2px solid #333;padding:4px 0;}
  .footer{text-align:center;margin-top:16px;padding-top:8px;font-size:12px;color:#555;}
  @media print{body{max-width:80mm;padding:0;}}
</style></head>
<body>
<div class="header">
  ${hasLogo ? `<img class="logo" src="${escHtml(logoSrc)}" alt="${businessName}" />` : ""}
  <h2 class="${nameSizeClass(business?.name)}">${businessName}</h2>
  <div class="address">${escHtml(addr || "")}</div>
  ${bPhone ? `<div class="address">Tel: ${escHtml(bPhone)}</div>` : ""}
</div>
<div class="order-info">
  <strong>Order:</strong> ${escHtml(order.order_number)}<br>
  <strong>Date:</strong> ${escHtml(formatDatetime(order.inserted_at))}<br>
  <strong>Type:</strong> ${escHtml(orderTypeText(order))}<br>
  ${order.customer_name ? `<strong>Customer:</strong> ${escHtml(order.customer_name)}<br>` : order.user?.full_name ? `<strong>Customer:</strong> ${escHtml(order.user.full_name)}<br>` : ""}
</div>
<div class="callout">
  <div class="number">${escHtml(callout)}</div>
  <div class="label">CALL OUT NUMBER</div>
</div>
<table>
  <tr style="border-bottom:1px solid #ccc;"><td class="item-name"><strong>Item</strong></td><td class="item-qty"><strong>Qty</strong></td><td class="item-price"><strong>Price</strong></td></tr>
  ${itemRows}
</table>
<div class="totals">
  <table>
    <tr><td class="label">Subtotal</td><td class="amount">${formatMoney(order.subtotal_minor, order)}</td></tr>
    ${order.delivery_fee_minor ? `<tr><td class="label">Delivery Fee</td><td class="amount">${formatMoney(order.delivery_fee_minor, order)}</td></tr>` : ""}
    ${taxRowsHtml}
    ${order.discount_minor ? `<tr><td class="label">Discount</td><td class="amount">-${formatMoney(order.discount_minor, order)}</td></tr>` : ""}
    <tr class="total-row"><td class="label">TOTAL</td><td class="amount">${formatMoney(order.total_minor, order)}</td></tr>
    <tr><td colspan="2" style="text-align:center;padding-top:8px;">${escHtml(paymentLineText(order))}</td></tr>
  </table>
</div>
<div class="footer">
  Thank you for your order!<br>Come back soon!
</div>
</body></html>`;
}
