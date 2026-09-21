import { describe, it, expect } from "vitest";
import { escposText, calloutNumber, generateEscpos } from "./receipt";
import type { SellerOrder } from "../types/api/seller.api";

const GS = 0x1d;

function order(overrides: Partial<SellerOrder> = {}): SellerOrder {
  return {
    id: "o1",
    order_number: "07-001-005",
    callout_number: null,
    currency_code: "GHS",
    subtotal_minor: 1000,
    total_minor: 1000,
    items: [],
    business: { name: "Akwaaba Bites" } as SellerOrder["business"],
    ...overrides,
  } as SellerOrder;
}

describe("escposText", () => {
  it("maps cedi sign and box drawing to ASCII", () => {
    expect(escposText("₵12.00")).toBe("GHc12.00");
    expect(escposText("═".repeat(3))).toBe("===");
    expect(escposText("Jollof — spicy • hot")).toBe("Jollof - spicy * hot");
  });

  it("strips remaining non-ASCII", () => {
    expect(escposText("Café")).toBe("Caf?");
    expect(escposText("plain ascii")).toBe("plain ascii");
  });
});

describe("calloutNumber", () => {
  it("prefers the backend callout_number field", () => {
    expect(calloutNumber(order({ callout_number: 42 }))).toBe("42");
  });

  it("never returns a negative for DD-RRR-CCC numbers (old -5 bug)", () => {
    expect(calloutNumber(order({ order_number: "07-001-005" }))).toBe("5");
    expect(calloutNumber(order({ order_number: "TFL-2026-0007" }))).toBe("7");
  });

  it("falls back to ---- with no number", () => {
    expect(calloutNumber(order({ order_number: "" }))).toBe("----");
  });
});

describe("generateEscpos", () => {
  it("sizes the barcode down and keeps text ASCII-clean", () => {
    const out = generateEscpos(
      order({
        items: [
          {
            menu_item: { name: "Jollof special" },
            quantity: 2,
            unit_price: 1500,
          } as never,
        ],
      }),
    );
    // GS h 60, GS w 2 precede the CODE128 (GS k 73) header
    const gsH = String.fromCharCode(GS, 0x68, 0x3c);
    const gsW = String.fromCharCode(GS, 0x77, 0x02);
    const code128 = String.fromCharCode(GS, 0x6b, 0x49);
    expect(out).toContain(gsH);
    expect(out).toContain(gsW);
    expect(out.indexOf(gsH)).toBeLessThan(out.indexOf(code128));
    // No raw cedi sign survives in text segments
    expect(out).not.toContain("₵");
    expect(out).toContain("GHc30.00");
    expect(out).toContain("Callout: 5");
  });
});

describe("golden 80mm receipt (docs/receipt-template.md)", () => {
  const golden = (): SellerOrder =>
    ({
      id: "golden-1",
      order_number: "07-014-042",
      callout_number: 42,
      currency_code: "GHS",
      subtotal_minor: 17900,
      delivery_fee_minor: 0,
      discount_minor: 1000,
      total_minor: 17437,
      inserted_at: "2026-09-19T10:00:00Z",
      order_type: "takeout",
      pos_payment_method: "cash",
      customer_name: "Kwame Mensah",
      business: {
        name: "Mama Efya's Kitchen & Grill Spot Accra",
        location: { address: "Osu Badu Street" },
        phone: "0244123456",
      },
      items: [
        {
          quantity: 2,
          unit_price: 5500,
          menu_item: { name: "Jollof Rice" },
          variant: { name: "Large" },
          order_item_addons: [
            { price_minor: 2500, addon: { name: "Extra Chicken" } },
            { price_minor: 1200, addon: { name: "Salad" } },
          ],
        },
        {
          quantity: 1,
          unit_price: 3200,
          menu_item: { name: "Waakye Special Morning Meal" },
          variant: null,
          order_item_addons: [],
        },
      ],
      tax_lines: [],
      order_tax_lines: [{ name: "VAT", rate_basis_points: 300, tax_amount_minor: 537 }],
    }) as unknown as SellerOrder;

  function printableLines(out: string, orderNumber: string): string[] {
    const withoutBarcode = out.split(
      String.fromCharCode(0x1d, 0x6b, 0x49, orderNumber.length) + orderNumber,
    ).join("");
    // Normalize the Date line: backend renders UTC, JS renders local TZ.
    const normalized = withoutBarcode.replace(
      /^Date: .*$/m,
      "Date: 19 Sep 2026 10:00",
    );
    const stripped = normalized.replace(
      /\x1B(?:@|[aEd].)|\x1D(?:[!Vhw].)/g,
      "",
    );
    const lines = stripped.split("\n");
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  it("matches the backend byte-for-byte in printable lines", () => {
    const lines = printableLines(generateEscpos(golden()), "07-014-042");
    expect(lines).toEqual([
      "Mama Efya's Kitchen & Grill Spot",
      "Accra",
      "Osu Badu Street",
      "Tel: 0244123456",
      "================================",
      "Order: 07-014-042",
      "",
      "Callout: 42",
      "",
      "Date: 19 Sep 2026 10:00",
      "Type: Takeout",
      "Customer: Kwame Mensah",
      "",
      "",
      "Item              Qty      Price",
      "--------------------------------",
      "Jollof Rice         2  GHc110.00",
      "  Size: Large",
      "  + Extra Chicken       GHc25.00",
      "  + Salad               GHc12.00",
      "Waakye Special      1   GHc32.00",
      "Morning Meal     ",
      "--------------------------------",
      "Subtotal:              GHc179.00",
      "VAT (3%)                 GHc5.37",
      "Discount:              -GHc10.00",
      "",
      "TOTAL:                 GHc174.37",
      "",
      "Payment: Cash",
      "================================",
      "Thank you for your order!",
      "Come back soon!",
    ]);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(32);
  });
});
