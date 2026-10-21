"use client";

/**
 * Insights building blocks (AN-02..AN-11): one chart card for every metric
 * family, configured by props, each with its own agent + period filters
 * (independent per card, as in the reference where Today and Yesterday
 * coexist). Requests are aborted on change so a slow answer can't
 * overwrite a newer one. States: loading, data, empty ("No data"),
 * needs-migration, error + Retry. Charts carry a text summary for screen
 * readers; values never rely on colour alone.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { BarChart } from "@/components/tremor/bar-chart";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/insights/format";

export type InsightMetric = "response_time" | "replied" | "opened" | "closed";
export type InsightPreset = "today" | "yesterday" | "last_7_days" | "last_30_days" | "custom";

// ── Members (agent names) ──────────────────────────────────────────

interface Member {
  user_id: string;
  full_name?: string | null;
  email?: string | null;
}
const MembersCtx = createContext<Member[]>([]);

export function MembersProvider({ children }: { children: React.ReactNode }) {
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/account/members", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((j: { members?: Member[] }) => {
        if (!cancelled) setMembers(j.members ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return <MembersCtx.Provider value={members}>{children}</MembersCtx.Provider>;
}

export function useAgentName() {
  const members = useContext(MembersCtx);
  const t = useTranslations("Insights");
  return useCallback(
    (id: string | null) => {
      if (!id) return t("unassigned");
      const m = members.find((x) => x.user_id === id);
      return m ? m.full_name || m.email || t("member") : t("formerMember");
    },
    [members, t],
  );
}

export const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

// ── Filters ─────────────────────────────────────────────────────────

const SELECT = "h-8 rounded-md border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary";

export function AgentSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useTranslations("Insights");
  const members = useContext(MembersCtx);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={SELECT} aria-label={t("agent")}>
      <option value="">{t("allAgents")}</option>
      {members.map((m) => (
        <option key={m.user_id} value={m.user_id}>
          {m.full_name || m.email || m.user_id}
        </option>
      ))}
    </select>
  );
}

export interface PeriodValue {
  preset: InsightPreset;
  from?: string;
  to?: string;
}

export function PeriodSelect({ value, onChange, allowEmpty }: { value: PeriodValue | null; onChange: (v: PeriodValue | null) => void; allowEmpty?: boolean }) {
  const t = useTranslations("Insights");
  const today = new Date().toLocaleDateString("en-CA");
  return (
    <div className="flex flex-wrap items-center gap-1">
      <select
        value={value?.preset ?? ""}
        onChange={(e) => onChange(e.target.value ? { preset: e.target.value as InsightPreset, from: value?.from, to: value?.to } : null)}
        className={SELECT}
        aria-label={t("period")}
      >
        {allowEmpty && <option value="">{t("selectRange")}</option>}
        {(["today", "yesterday", "last_7_days", "last_30_days", "custom"] as const).map((p) => (
          <option key={p} value={p}>
            {t(`presets.${p}`)}
          </option>
        ))}
      </select>
      {value?.preset === "custom" && (
        <>
          <input type="date" max={today} value={value.from ?? ""} onChange={(e) => onChange({ ...value, from: e.target.value })} className={SELECT} aria-label={t("from")} />
          <input type="date" max={today} value={value.to ?? ""} onChange={(e) => onChange({ ...value, to: e.target.value })} className={SELECT} aria-label={t("to")} />
        </>
      )}
    </div>
  );
}

// ── Data ────────────────────────────────────────────────────────────

export interface MetricPayload {
  series: { bucket: string; value: number | null; samples?: number }[];
  total: number | null;
  samples?: number;
  by_agent: { agent_id: string | null; value: number; samples?: number }[];
  history_since: string | null;
  version: string;
  period: { tz: string; bucket: "hour" | "day"; days: string[] };
}

type Load = { state: "loading" } | { state: "error"; message: string; code?: string } | { state: "ready"; data: MetricPayload };

export function useMetric(metric: InsightMetric, period: PeriodValue | null, agent: string): [Load, () => void] {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [nonce, setNonce] = useState(0);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!period || (period.preset === "custom" && (!period.from || !period.to))) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    const qs = new URLSearchParams({ metric, preset: period.preset, tz: timeZone() });
    if (period.preset === "custom") {
      qs.set("from", period.from!);
      qs.set("to", period.to!);
    }
    if (agent) qs.set("agent", agent);
    void (async () => {
      setLoad({ state: "loading" });
      try {
        const res = await fetch(`/api/insights/metric?${qs}`, { signal: c.signal, cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (c.signal.aborted) return;
        if (!res.ok) setLoad({ state: "error", message: json.error ?? `HTTP ${res.status}`, code: json.code });
        else setLoad({ state: "ready", data: json as MetricPayload });
      } catch (err) {
        if (!c.signal.aborted) setLoad({ state: "error", message: err instanceof Error ? err.message : "Network error" });
      }
    })();
    return () => c.abort();
  }, [metric, period, agent, nonce]);
  return [load, () => setNonce((n) => n + 1)];
}

const label = (bucket: string, kind: "hour" | "day") =>
  kind === "hour" ? bucket.slice(11, 16) : new Date(`${bucket}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

// ── Card ────────────────────────────────────────────────────────────

const PIE_COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#8b5cf6", "#ef4444", "#06b6d4", "#84cc16", "#ec4899"];

export function InsightCard({
  metric,
  title,
  description,
  view,
  defaultPreset,
}: {
  metric: InsightMetric;
  title: string;
  description?: string;
  view: "bars" | "agent_pie" | "agent_bars";
  defaultPreset: InsightPreset;
}) {
  const t = useTranslations("Insights");
  const agentName = useAgentName();
  const [agent, setAgent] = useState("");
  const [period, setPeriod] = useState<PeriodValue | null>({ preset: defaultPreset });
  const stablePeriod = useMemo(() => period, [period]);
  const [load, retry] = useMetric(metric, stablePeriod, agent);
  const isDuration = metric === "response_time";
  const fmt = (v: number) => (isDuration ? formatDuration(v) : String(v));

  let body: React.ReactNode;
  if (load.state === "loading") {
    body = (
      <div className="text-muted-foreground flex h-56 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin" aria-label={t("loading")} />
      </div>
    );
  } else if (load.state === "error") {
    body = (
      <div className="flex h-56 flex-col items-center justify-center gap-2 text-center text-sm">
        <p className={load.code === "needs_migration" ? "text-amber-600" : "text-red-500"}>{load.message}</p>
        {load.code !== "needs_migration" && (
          <button type="button" onClick={retry} className="text-primary inline-flex items-center gap-1 text-xs hover:underline">
            <RotateCcw className="h-3.5 w-3.5" /> {t("retry")}
          </button>
        )}
      </div>
    );
  } else {
    const d = load.data;
    const empty = view === "bars" ? (isDuration ? !d.samples : !d.total) : d.by_agent.length === 0;
    if (empty) {
      body = <p className="text-muted-foreground flex h-56 items-center justify-center text-sm">{t("noData")}</p>;
    } else if (view === "bars") {
      const data = d.series.map((p) => ({ label: label(p.bucket, d.period.bucket), [title]: p.value ?? 0 }));
      body = (
        <>
          <BarChart
            className="h-56"
            data={data}
            index="label"
            categories={[title]}
            colors={["emerald"]}
            valueFormatter={fmt}
            showLegend={false}
            yAxisWidth={isDuration ? 64 : 40}
            yAxisLabel={isDuration ? t("seconds") : t("count")}
          />
          <p className="sr-only">{d.series.map((p) => `${p.bucket}: ${p.value === null ? t("noData") : fmt(p.value)}`).join("; ")}</p>
        </>
      );
    } else if (view === "agent_pie") {
      const rows = d.by_agent.map((r, i) => ({ name: agentName(r.agent_id), value: r.value, color: PIE_COLORS[i % PIE_COLORS.length] }));
      body = (
        <div className="flex h-56 items-center gap-4">
          <div className="h-full min-w-0 flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={rows} dataKey="value" nameKey="name" innerRadius="45%" outerRadius="80%" paddingAngle={1}>
                  {rows.map((r) => (
                    <Cell key={r.name} fill={r.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => String(v)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="w-40 space-y-1 text-xs" aria-label={t("legend")}>
            {rows.map((r) => (
              <li key={r.name} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: r.color }} />
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                <span className="tabular-nums">{r.value}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    } else {
      const data = d.by_agent.map((r) => ({ label: agentName(r.agent_id), [title]: r.value, samples: r.samples }));
      body = (
        <>
          <BarChart className="h-56" data={data} index="label" categories={[title]} colors={["emerald"]} valueFormatter={fmt} showLegend={false} layout="vertical" yAxisWidth={110} />
          <p className="sr-only">{data.map((r) => `${r.label}: ${fmt(Number(r[title]))} (${r.samples ?? 0})`).join("; ")}</p>
        </>
      );
    }
  }

  const ready = load.state === "ready" ? load.data : null;
  return (
    <section className="border-border bg-card flex flex-col rounded-xl border p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && <p className="text-muted-foreground text-xs">{description}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <AgentSelect value={agent} onChange={setAgent} />
          <PeriodSelect value={period} onChange={(v) => v && setPeriod(v)} />
        </div>
      </div>
      {body}
      {ready && (
        <p className="text-muted-foreground mt-2 text-[11px]">
          {isDuration
            ? t("footDuration", { value: formatDuration(ready.total), samples: ready.samples ?? 0 })
            : t("footCount", { value: ready.total ?? 0 })}
          {" · "}
          {ready.period.tz}
        </p>
      )}
    </section>
  );
}

// ── KPI ─────────────────────────────────────────────────────────────

export function KpiCard({ title, value, unit, scope, loading, error }: { title: string; value: string; unit: string; scope: string[]; loading: boolean; error?: string }) {
  return (
    <section className="border-border bg-card rounded-xl border p-4">
      <h3 className="text-muted-foreground text-xs font-medium">{title}</h3>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", error && "text-red-500 text-sm font-normal")}>
        {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : error ?? value}
      </div>
      <div className="text-muted-foreground mt-2 flex flex-wrap gap-1.5 text-[11px]">
        <span className="bg-muted rounded px-1.5 py-0.5">{unit}</span>
        {scope.map((s) => (
          <span key={s} className="bg-muted rounded px-1.5 py-0.5">{s}</span>
        ))}
      </div>
    </section>
  );
}
