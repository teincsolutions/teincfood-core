import { describe, it, expect, beforeEach } from "vitest";
import { openSyncDatabase } from "../db/connection";
import { getReferenceData, setReferenceData, mergeReferenceData } from "./operations";
import { setSqliteDriver } from "../adapters/sqlite";

// simple in-memory sqlite mock for operations tests
class MemDB {
  tables: Map<string, Map<string, string>> = new Map();
  async execAsync(_sql: string) {}
  async runAsync(sql: string, ...params: unknown[]) {
    if (sql.includes("INSERT INTO reference_data")) {
      const [business_id, key, version, payload, downloaded_at, last_event_id, last_hlc] = params as string[];
      let m = this.tables.get("reference_data");
      if (!m) { m = new Map(); this.tables.set("reference_data", m); }
      const existing = m.get(`${business_id}:${key}`);
      // mimic merge behavior via setReferenceData logic in test calling mergeReferenceData
      m.set(`${business_id}:${key}`, JSON.stringify({ business_id, key, version, payload, downloaded_at, last_event_id, last_hlc }));
      return { lastInsertRowId: 1, changes: 1 } as any;
    }
    if (sql.includes("INSERT INTO reference_data") && sql.includes("ON CONFLICT")) {}
    return { lastInsertRowId: 1, changes: 1 } as any;
  }
  async getFirstAsync<T>(sql: string, ...params: unknown[]): Promise<T | null> {
    if (sql.includes("SELECT * FROM reference_data")) {
      const [business_id, key] = params as string[];
      const m = this.tables.get("reference_data");
      if (!m) return null;
      const raw = m.get(`${business_id}:${key}`);
      if (!raw) return null;
      const j = JSON.parse(raw);
      return { key: j.key, version: j.version, payload: j.payload, downloaded_at: j.downloaded_at, last_event_id: j.last_event_id, last_hlc: j.last_hlc } as unknown as T;
    }
    if (sql.includes("SELECT version")) {
      const [business_id, key] = params as string[];
      const m = this.tables.get("reference_data");
      const raw = m?.get(`${business_id}:${key}`);
      if (!raw) return null;
      const j = JSON.parse(raw);
      return { version: j.version } as unknown as T;
    }
    return null;
  }
  async getAllAsync() { return [] as any; }
}

describe("reference operations LWW", () => {
  it("merge keeps newer HLC", async () => {
    const db = new MemDB() as any;
    await setReferenceData(db, "biz1", { key: "business:profile", version: "1000-000000-01", payload: { name: "A" }, downloadedAt: new Date().toISOString(), lastHlc: "1000-000000-01", lastEventId: "evt_1" });
    let rec = await getReferenceData(db, "biz1", "business:profile");
    expect(rec?.lastHlc).toBe("1000-000000-01");
    // older HLC should not overwrite
    await mergeReferenceData(db, "biz1", "business:profile", { name: "B" } as any, "0999-000000-01", "evt_0");
    rec = await getReferenceData(db, "biz1", "business:profile");
    // still A because incoming older
    expect(rec?.payload).toEqual({ name: "A" });
    // newer wins
    await mergeReferenceData(db, "biz1", "business:profile", { name: "C" } as any, "1001-000000-02", "evt_2");
    rec = await getReferenceData(db, "biz1", "business:profile");
    expect(rec?.payload).toEqual({ name: "C" });
  });
});
