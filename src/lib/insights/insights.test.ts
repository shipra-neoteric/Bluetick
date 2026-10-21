import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { bucketKeys, resolvePeriod } from "./period";
import { fillSeries, type MetricResult } from "./metrics";
import { formatDuration } from "./format";
import { buildAgentActivityWorkbook, safeText } from "./reports";

const NOW = new Date("2026-10-21T20:00:00Z"); // 22 Oct 01:30 in Kolkata

describe("resolvePeriod", () => {
  it("uses local days in the given time zone, half-open", () => {
    const r = resolvePeriod({ preset: "today", tz: "Asia/Kolkata" }, NOW);
    if (!r.ok) throw new Error(r.error);
    expect(r.period.days).toEqual(["2026-10-22"]);
    expect(r.period.from.toISOString()).toBe("2026-10-21T18:30:00.000Z");
    expect(r.period.to.toISOString()).toBe("2026-10-22T18:30:00.000Z");
    expect(r.period.bucket).toBe("hour");
  });
  it("yesterday and last 7 days (today included)", () => {
    const y = resolvePeriod({ preset: "yesterday", tz: "UTC" }, NOW);
    const w = resolvePeriod({ preset: "last_7_days", tz: "UTC" }, NOW);
    if (!y.ok || !w.ok) throw new Error("bad");
    expect(y.period.days).toEqual(["2026-10-20"]);
    expect(w.period.days).toHaveLength(7);
    expect(w.period.days[6]).toBe("2026-10-21");
    expect(w.period.bucket).toBe("day");
  });
  it("validates custom ranges", () => {
    expect(resolvePeriod({ preset: "custom", from: "2026-10-10", to: "2026-10-01", tz: "UTC" }, NOW)).toMatchObject({ ok: false });
    expect(resolvePeriod({ preset: "custom", from: "2026-11-01", to: "2026-11-02", tz: "UTC" }, NOW)).toMatchObject({ ok: false });
    expect(resolvePeriod({ preset: "custom", from: "2026-01-01", to: "2026-10-01", tz: "UTC" }, NOW)).toMatchObject({ ok: false });
    expect(resolvePeriod({ preset: "today", tz: "Mars/Base" }, NOW)).toMatchObject({ ok: false });
  });
  it("hour buckets match the SQL labels", () => {
    const r = resolvePeriod({ preset: "today", tz: "UTC" }, NOW);
    if (!r.ok) throw new Error("bad");
    const keys = bucketKeys(r.period);
    expect(keys).toHaveLength(24);
    expect(keys[10]).toBe("2026-10-21T10:00");
  });
});

describe("fillSeries", () => {
  const period = (() => {
    const r = resolvePeriod({ preset: "last_7_days", tz: "UTC" }, NOW);
    if (!r.ok) throw new Error("bad");
    return r.period;
  })();
  it("counts get real zeros, durations get no data", () => {
    const counts = fillSeries("replied", period, [{ bucket: "2026-10-20", value: 3 }]);
    expect(counts.map((p) => p.value)).toEqual([0, 0, 0, 0, 0, 3, 0]);
    const rt = fillSeries("response_time", period, [{ bucket: "2026-10-20", value: 120, samples: 2 }]);
    expect(rt[0].value).toBeNull();
    expect(rt[5]).toEqual({ bucket: "2026-10-20", value: 120, samples: 2 });
  });
});

describe("formatDuration", () => {
  it("formats seconds and never shows 0 for no data", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(65)).toBe("1m 5s");
    expect(formatDuration(3_900)).toBe("1h 5m");
    expect(formatDuration(90_000)).toBe("1d 1h");
  });
});

describe("agent activity workbook", () => {
  const period = (() => {
    const r = resolvePeriod({ preset: "last_7_days", tz: "Asia/Kolkata" }, NOW);
    if (!r.ok) throw new Error("bad");
    return r.period;
  })();
  const base = (metric: MetricResult["metric"], extra: Partial<MetricResult>): MetricResult => ({
    metric,
    version: "insights-v1",
    series: fillSeries(metric, period, []),
    total: metric === "response_time" ? null : 0,
    by_agent: [],
    history_since: "2026-10-01T00:00:00Z",
    ...extra,
  });
  it("writes a real xlsx with weighted averages and safe text", () => {
    const bytes = buildAgentActivityWorkbook({
      period,
      generatedAt: new Date("2026-10-21T20:00:00Z"),
      scopeLabel: "All agents",
      agentNames: new Map([["a1", "=HYPERLINK(\"x\")"], ["b1", "Bob"]]),
      // Unequal samples: (3×100 + 1×500) / 4 = 200, not (100+500)/2.
      response: base("response_time", {
        total: 200,
        samples: 4,
        total_seconds: 800,
        by_agent: [
          { agent_id: "a1", value: 100, samples: 3, total_seconds: 300 },
          { agent_id: "b1", value: 500, samples: 1, total_seconds: 500 },
        ],
      }),
      replied: base("replied", { total: 3, by_agent: [{ agent_id: "a1", value: 2 }, { agent_id: "b1", value: 1 }] }),
      opened: base("opened", { total: 1, by_agent: [{ agent_id: null, value: 1 }] }),
      closed: base("closed", { total: 0 }),
    });
    const wb = XLSX.read(bytes, { type: "array" });
    expect(wb.SheetNames).toEqual(["Summary", "Agents", "Daily"]);
    const agents = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets.Agents);
    const a1 = agents.find((r) => r["Agent ID"] === "a1")!;
    expect(a1.Agent).toBe("'=HYPERLINK(\"x\")");
    expect(a1["Conversations replied (first replier)"]).toBe(2);
    // Agent rows reconcile with the totals.
    const repliedSum = agents.reduce((n, r) => n + Number(r["Conversations replied (first replier)"] ?? 0), 0);
    expect(repliedSum).toBe(3);
    const samples = agents.reduce((n, r) => n + Number(r["Response samples"] ?? 0), 0);
    expect(samples).toBe(4);
    expect(agents.some((r) => r.Agent === "Unassigned / unknown")).toBe(true);
    const summary = XLSX.utils.sheet_to_json<string[]>(wb.Sheets.Summary, { header: 1 });
    expect(summary.find((r) => r[0] === "Average response seconds")?.[1]).toBe(200);
    expect(summary.find((r) => r[0] === "Time zone")?.[1]).toBe("Asia/Kolkata");
  });
  it("safeText neutralises formulas", () => {
    expect(safeText("+91 98")).toBe("'+91 98");
    expect(safeText("Asha")).toBe("Asha");
  });
});
