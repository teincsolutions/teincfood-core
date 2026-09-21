# Receipt template (single source of design)

80mm thermal, font A, **32 columns**. All human-readable text is sanitized
to ASCII first (`escposText`: `₵`→`GHc`, box-drawing→`=`/`-`, other
non-ASCII→`?`). Never truncate user data — wrap instead; the only width cap
is money fields (see price column).

Two generators implement this spec and must stay identical in layout:
- Backend: `TeincFoodBackend.Orders.Receipt`
  (`lib/teinc_food_backend/orders/receipt.ex`) — served at
  `GET /orders/:id/receipt?format=escpos|html`, consumed by the buyer app.
- Frontend (offline): `teincfood-core/src/printer/receipt.ts` — used by the
  desktop + mobile seller apps for local/queued orders.
- HTML is a visual twin of the ESC/POS rows (same sections, order,
  spacing, monospace 32-col grid), used for previews, regular printers
  and email. Preview must equal print must equal thermal.

Consistency is enforced by golden fixtures:
- `test/teinc_food_backend/orders/receipt_test.exs` ("golden 80mm receipt")
- `src/printer/receipt.test.ts` ("golden 80mm receipt")

## Sections (in order)

```
[center] LOGO RASTER (when available, §0)
[center] BUSINESS NAME (fit ladder, §1)
[center] address (1x, if present)
[center] Tel: <phone> (1x, if present)
================================  (32 "=")
[left]   Order: <order_number>

[center] Callout: <n> (2x width+height, GS ! 0x11, blank line above and below, no border rules)

[left]   Date: <dd Mon yyyy HH:MM>
[left]   Type: <Takeout|Dine-in|Delivery|Pay on Delivery|Prepaid|Walk-in>
[left]   Customer: <name> | Phone: <phone> (whichever present)
         <blank>
[center] CODE128 barcode of order_number (height 0x3C, width 2)
         <blank>
[left]   items header + rule + items + rule (§2)
[left]   totals block (§3)
[center] Payment: <line>
[center] ================================
[center] Thank you for your order!
[center] Come back soon!
         <blank>
[center] §4 company block (never truncated, all lines ≤ 32 cols):
         <website>                                  e.g. https://teincfood.com
         Powered by <company name>                  e.g. Powered by TeincFood
         feed 3, full cut
```

## §0 Business logo (top, fixed size for all)

When the business has a logo it prints centered above the name:
- ESC/POS: pre-rasterized monochrome `GS v 0` block, fit inside
  384×96 dots, thresholded at 50%, horizontally centered via `ESC $`.
  PNG only; anything else (or any failure) prints no logo — never fail
  the receipt. Backend rasterizes with `Orders.LogoRaster` (pure Elixir,
  zero deps); the bytes travel base64 as `logo_escpos` in the
  `business:profile` reference payload so offline devices splice
  print-ready bytes with no image pipeline.
- HTML twin: `<img class="logo">`, `max-width:200px;max-height:64px`,
  centered. Same box on backend and frontend output.

## §4 Company footer

Values (backend: `COMPANY_*` OS env; frontend: `VITE_COMPANY_*` /
`EXPO_PUBLIC_COMPANY_*` wired to `setCompanyInfo`; identical defaults):

| key     | default               |
| ------- | --------------------- |
| name    | TeincFood             |
| website | https://teincfood.com |

## §1 Business-name fit ladder (centered, never truncated)

Sanitized length L (after `escposText`):

| L       | size                              | lines              |
| ------- | --------------------------------- | ------------------ |
| ≤ 16    | 2× width+height (`GS ! 0x11`)     | 1                  |
| 17–64   | 1× bold                           | wrap to ≤ 2 lines  |
| > 64    | 1× normal                         | wrap to ≤ 3 lines  |

Word-wrap at spaces; a single word longer than 32 chars hard-wraps.
Beyond 3 lines keep wrapping — data loss (truncation) is forbidden.
HTML twin: `.name-2x` (28px bold) / `.name-1x-bold` / `.name-1x`, centered,
natural wrap, no line clamp.

## §2 Item block (every content line is exactly 32 cols)

Columns: `name 17 | space | qty 3 (right) | space | price 10 (right)`.
Header row uses the same columns (`Item`, `Qty`, `Price`).

- Main line: name truncated? No — name wraps to max 2 lines at 17 chars
  (word-wrap, continuation lines carry no qty/price).
- Variant line (when present): `  Size: <name>`, word-wrapped at 32 cols.
- Addon lines: `  + <name17> <price10-right>`; name wraps like item names.
- Prices: `GHc<major.2f>` (no thousands separator), right-aligned in 10.
  Amounts ≥ GHc 10,000 exceed the column and overflow right — accepted
  rare edge (money is never truncated or rounded).
- Money is exact minor-unit math; totals rendered from order fields, never
  recomputed from lines.

HTML twin: monospace table, `name 17ch | qty 3ch right | price 10ch right`,
variant/addon sub-rows, identical order.

## §3 Totals block (label 20 + space + amount 11)

```
Subtotal:            GHc…
Delivery Fee:        GHc…   (only if > 0)
<tax name (pct%)>    GHc…
Discount:           -GHc…   (only if > 0)
<blank>
TOTAL:               GHc…   (bold, ESC E; flame-retardant rules around)
<blank>
```

HTML twin: same rows; `.total-row` gets `margin-top` (the required gap
between subtotal block and TOTAL) plus the bold top/bottom rules.
