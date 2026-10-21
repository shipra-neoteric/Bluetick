import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  insertError: null as { code?: string; message: string } | null,
  updates: [] as Record<string, unknown>[],
  rpcError: null as { message: string } | null,
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b;
      b.insert = () => b;
      b.single = async () => (h.insertError ? { data: null, error: h.insertError } : { data: { id: "rep-1" }, error: null });
      b.update = (p: Record<string, unknown>) => {
        h.updates.push(p);
        return { eq: async () => ({ error: null }) };
      };
      b.then = (res: (r: unknown) => unknown) =>
        res({ data: table === "profiles" ? [{ user_id: "a1", full_name: "Alice", email: null }] : [], error: null });
      return b;
    },
  }),
}));

import { decodeBytea, generateReport, normalizeParams } from "./generate";
import * as XLSX from "xlsx";

const userDb = {
  rpc: async (_fn: string, args: { p_metric: string }) =>
    h.rpcError
      ? { data: null, error: h.rpcError }
      : {
          data: {
            series: [],
            total: args.p_metric === "response_time" ? null : 0,
            samples: 0,
            total_seconds: 0,
            by_agent: [],
            version: "insights-v1",
            history_since: null,
          },
          error: null,
        },
} as never;

const base = { userDb, accountId: "acc", userId: "a1" };

beforeEach(() => {
  h.insertError = null;
  h.updates = [];
  h.rpcError = null;
});

describe("generateReport", () => {
  it("rejects an unknown report type", async () => {
    const r = await generateReport({ ...base, type: "account_summary" as never, params: { preset: "today", tz: "UTC" } });
    expect(r).toMatchObject({ ok: false, status: 400, code: "unknown_type" });
  });
  it("rejects an invalid period before recording anything", async () => {
    const r = await generateReport({ ...base, type: "agent_activity", params: { preset: "custom", from: "2026-10-10", to: "2026-10-01", tz: "UTC" } });
    expect(r).toMatchObject({ ok: false, status: 400, code: "invalid_period" });
    expect(h.updates).toHaveLength(0);
  });
  it("a duplicate active request is refused", async () => {
    h.insertError = { code: "23505", message: "duplicate key" };
    const r = await generateReport({ ...base, type: "agent_activity", params: { preset: "today", tz: "UTC" } });
    expect(r).toMatchObject({ ok: false, status: 409, code: "duplicate" });
  });
  it("stores a real xlsx and marks Complete with an expiry", async () => {
    const r = await generateReport({ ...base, type: "agent_activity", params: { preset: "last_7_days", tz: "Asia/Kolkata" } });
    expect(r).toEqual({ ok: true, id: "rep-1" });
    const done = h.updates.find((u) => u.status === "complete")!;
    expect(String(done.file_name)).toMatch(/^agent-activity_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(Date.parse(String(done.expires_at))).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const bytes = decodeBytea(done.file_data)!;
    expect(XLSX.read(bytes, { type: "array" }).SheetNames).toContain("Agents");
  });
  it("records a failure (and never Complete) when data can't be read", async () => {
    h.rpcError = { message: "boom" };
    const r = await generateReport({ ...base, type: "agent_activity", params: { preset: "today", tz: "UTC" } });
    expect(r).toMatchObject({ ok: false, code: "failed" });
    expect(h.updates.some((u) => u.status === "complete")).toBe(false);
    expect(h.updates.some((u) => u.status === "failed")).toBe(true);
  });
  it("normalizes parameters for de-duplication", () => {
    expect(normalizeParams({ preset: "today", from: "x", tz: "UTC", agent_id: "" }).key).toBe(
      normalizeParams({ preset: "today", tz: "UTC" }).key,
    );
  });
});
