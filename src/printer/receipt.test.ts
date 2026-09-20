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
