import { describe, expect, it } from "vitest";
import {
  buildCustomerDisplayModel,
  resolvePhase,
  type CustomerDisplayInput,
} from "./model";

const base: CustomerDisplayInput = {
  branding: { name: "Teinc Foods", logoUrl: "https://cdn.example/logo.png" },
  currency: "GHS",
  items: [
    {
      id: "a",
      name: "Jollof",
      addons: ["Extra chicken"],
      quantity: 2,
      unitPriceMinor: 2500,
      lineTotalMinor: 5000,
    },
    {
      id: "b",
      name: "Water",
      addons: [],
      quantity: 1,
      unitPriceMinor: 500,
      lineTotalMinor: 500,
    },
  ],
  subtotalMinor: 5500,
  taxLines: [{ name: "VAT", amountMinor: 275 }],
  discountMinor: 0,
  totalMinor: 5775,
  now: 1000,
};

describe("buildCustomerDisplayModel", () => {
  it("sums item count across quantities", () => {
    const model = buildCustomerDisplayModel(base);
    expect(model.itemCount).toBe(3);
  });

  it("derives ordering phase from items when no runtime phase is set", () => {
    expect(buildCustomerDisplayModel(base).phase).toBe("ordering");
  });

  it("idles when there are no items", () => {
    const model = buildCustomerDisplayModel({
      ...base,
      items: [],
      subtotalMinor: 0,
      totalMinor: 0,
    });
    expect(model.phase).toBe("idle");
    expect(model.itemCount).toBe(0);
  });

  it("lets an explicit runtime phase win over derivation", () => {
    expect(resolvePhase({ ...base, phase: "confirmation" })).toBe(
      "confirmation",
    );
    expect(resolvePhase({ ...base, phase: "payment" })).toBe("payment");
  });

  it("passes through branding, payment and confirmation", () => {
    const model = buildCustomerDisplayModel({
      ...base,
      phase: "payment",
      payment: { method: "mobile_money", status: "processing" },
    });
    expect(model.branding?.name).toBe("Teinc Foods");
    expect(model.payment?.method).toBe("mobile_money");
    expect(model.payment?.status).toBe("processing");
    expect(model.updatedAt).toBe(1000);
  });
});
