import { describe, expect, it } from "vitest";
import { getCustomerDisplay } from "./customer-display";

describe("getCustomerDisplay", () => {
  it("keeps a POS teller separate from the typed customer", () => {
    const display = getCustomerDisplay({
      is_pos: true,
      customer_name: "Ama",
      customer_phone: "0244000000",
      user: { full_name: "Kojo Teller", phone: "0200000000" },
    });

    expect(display.name).toBe("Ama");
    expect(display.phone).toBe("0244000000");
    expect(display.tellerName).toBe("Kojo Teller");
    expect(display.isWalkIn).toBe(true);
  });

  it("does not turn a POS teller into a walk-in customer name", () => {
    const display = getCustomerDisplay({
      is_pos: true,
      customer_name: null,
      user: { full_name: "Kojo Teller" },
    });

    expect(display.name).toBe("Walk-in");
    expect(display.tellerName).toBe("Kojo Teller");
  });

  it("uses the linked user for an online customer order", () => {
    const display = getCustomerDisplay({
      is_pos: false,
      customer_name: null,
      user: { full_name: "Ama Customer", phone: "0244000000" },
    });

    expect(display.name).toBe("Ama Customer");
    expect(display.phone).toBe("0244000000");
    expect(display.tellerName).toBeUndefined();
  });
});
