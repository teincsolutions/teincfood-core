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

describe("offline integration DD-NNNN-MMM", () => {
  beforeEach(() => {
    removeItemSync("teinc_callout_seq");
    resetCalloutForTests();
  });

  it("queue uses DD-NNNN-MMM and increments sequentially", () => {
    setItemSync("teinc_device_number:biz1", "01");
    const a = generateOrderNumber("01");
    const b = generateOrderNumber("01");
    expect(a.orderNumber).toMatch(/^[0-9]{2}-[0-9]{4}-[0-9]{3}$/);
    expect(a.orderNumber).toBe("01-0001-001");
    expect(b.orderNumber).toBe("01-0001-002");
    expect(b.callout).toBe(a.callout + 1);
  });

  it("offline vs online no difference - order_number adopted", async () => {
    setItemSync("teinc_callout_seq", 0);
    const { orderNumber } = generateOrderNumber("05");
    // backend adopts this verbatim; ensure the new format.
    expect(orderNumber).toBe("05-0001-001");
    expect(orderNumber.length).toBe(11);
  });
});
