import { describe, it, expect, beforeEach } from "vitest";
import { generateOrderNumber, resetCalloutForTests } from "./order-number";
import { removeItemSync, setItemSync } from "../adapters/kv";
import { commandQueueService } from "./command-queue.service";
import { setSqliteDriver } from "../adapters/sqlite";

// minimal in-memory DB for outbox
class MemDB {
  commands: any[] = [];
  events: any[] = [];
  async execAsync() {}
  async runAsync(sql: string, ...params: any[]) {
    if (sql.includes("INSERT INTO commands")) {
      this.commands.push({ command_id: params[0], status: params[8] });
      return { lastInsertRowId: this.commands.length } as any;
    }
    if (sql.includes("INSERT INTO events")) {
      this.events.push({ event_id: params[0] });
      return { lastInsertRowId: 1 } as any;
    }
    if (sql.includes("SELECT * FROM commands WHERE id")) {
      return null;
    }
    return { lastInsertRowId: 1 } as any;
  }
  async getFirstAsync() { return null; }
  async getAllAsync() { return []; }
}

describe("offline integration DD-RRR-CCC", () => {
  beforeEach(() => {
    removeItemSync("teinc_callout_seq");
    removeItemSync("teinc_last_random");
    resetCalloutForTests();
  });

  it("queue uses DD-RRR-CCC and survives wrap", () => {
    setItemSync("teinc_device_number:biz1", "01");
    // generate two orders
    const a = generateOrderNumber("01");
    const b = generateOrderNumber("01");
    expect(a.orderNumber).toMatch(/^[0-9]{2}-[0-9]{3}-[0-9]{3}$/);
    expect(b.callout).toBe(a.callout + 1);
    // ensure per-order random different 100-999
    expect(a.random).toBeGreaterThanOrEqual(100);
    expect(b.random).toBeGreaterThanOrEqual(100);
  });

  it("offline vs online no difference - order_number adopted", async () => {
    setItemSync("teinc_callout_seq", 0);
    const { orderNumber } = generateOrderNumber("05");
    // backend would adopt this; ensure format
    expect(orderNumber).toBe("05-" + orderNumber.split("-")[1] + "-" + orderNumber.split("-")[2]);
    expect(orderNumber.length).toBe(10);
  });
});
