"use client";

/**
 * Bot logs — one place to read Flow runs and Automation runs. Reads the
 * existing tables (flow_runs + flow_run_events, automation_logs) through
 * RLS; each row keeps its engine, run id and the steps it took. Nothing
 * here re-runs or changes anything.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ExternalLink, Loader2, MessageSquare, Search, Workflow, Zap } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Engine = "flow" | "automation";
type RunState = "waiting_customer" | "waiting_time" | "completed" | "handed_off" | "failed" | "timed_out" | "paused" | "running";

interface RunRow {
  key: string;
  engine: Engine;
  id: string;
  sourceId: string;
  sourceName: string;
  contactId: string | null;
  contactName: string;
  contactPhone: string;
  conversationId: string | null;
  state: RunState;
  startedAt: string;
  trigger: string;
  detail?: string | null;
  steps?: { step_type: string; status: string; detail?: string }[];
}

interface FlowEvent {
  id: string;
  event_type: string;
  node_key: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

const FLOW_STATE: Record<string, RunState> = {
  active: "waiting_customer",
  completed: "completed",
  handed_off: "handed_off",
  timed_out: "timed_out",
  paused_by_agent: "paused",
  failed: "failed",
};
const AUTO_STATE: Record<string, RunState> = { success: "completed", partial: "waiting_time", failed: "failed" };
const STATE_TONE: Record<RunState, string> = {
  waiting_customer: "bg-sky-500/10 text-sky-600",
  waiting_time: "bg-violet-500/10 text-violet-600",
  completed: "bg-emerald-500/10 text-emerald-600",
  handed_off: "bg-amber-500/10 text-amber-600",
  failed: "bg-red-500/10 text-red-600",
  timed_out: "bg-slate-500/10 text-muted-foreground",
  paused: "bg-slate-500/10 text-muted-foreground",
  running: "bg-sky-500/10 text-sky-600",
};
const RANGES = [1, 7, 30] as const;
const LIMIT = 150;

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export default function BotLogsPage() {
  const t = useTranslations("BotStudio.logs");
  const [engine, setEngine] = useState<"all" | Engine>("all");
  const [stateFilter, setStateFilter] = useState<"all" | RunState>("all");
  const [days, setDays] = useState<number>(7);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<RunRow | null>(null);
  const [events, setEvents] = useState<FlowEvent[] | null>(null);

  useEffect(() => {
    const e = new URLSearchParams(window.location.search).get("engine");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time URL prefill
    if (e === "flow" || e === "automation") setEngine(e);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const [flowsRes, autosRes] = await Promise.all([
      engine === "automation"
        ? Promise.resolve({ data: [] })
        : supabase
            .from("flow_runs")
            .select("id, flow_id, status, started_at, end_reason, conversation_id, contact_id, flow:flows(name, trigger_type), contact:contacts(name, phone)")
            .gte("started_at", since)
            .order("started_at", { ascending: false })
            .limit(LIMIT),
      engine === "flow"
        ? Promise.resolve({ data: [] })
        : supabase
            .from("automation_logs")
            .select("id, automation_id, status, created_at, trigger_event, error_message, steps_executed, contact_id, automation:automations(name), contact:contacts(name, phone)")
            .gte("created_at", since)
            .order("created_at", { ascending: false })
            .limit(LIMIT),
    ]);
    const out: RunRow[] = [];
    for (const r of (flowsRes.data ?? []) as unknown as Record<string, unknown>[]) {
      const flow = one(r.flow as { name: string; trigger_type: string } | null);
      const contact = one(r.contact as { name: string | null; phone: string | null } | null);
      out.push({
        key: `f:${r.id}`,
        engine: "flow",
        id: String(r.id),
        sourceId: String(r.flow_id),
        sourceName: flow?.name ?? "—",
        contactId: (r.contact_id as string) ?? null,
        contactName: contact?.name ?? "",
        contactPhone: contact?.phone ?? "",
        conversationId: (r.conversation_id as string) ?? null,
        state: FLOW_STATE[String(r.status)] ?? "running",
        startedAt: String(r.started_at),
        trigger: flow?.trigger_type ?? "",
        detail: (r.end_reason as string) ?? null,
      });
    }
    for (const r of (autosRes.data ?? []) as unknown as Record<string, unknown>[]) {
      const auto = one(r.automation as { name: string } | null);
      const contact = one(r.contact as { name: string | null; phone: string | null } | null);
      out.push({
        key: `a:${r.id}`,
        engine: "automation",
        id: String(r.id),
        sourceId: String(r.automation_id),
        sourceName: auto?.name ?? "—",
        contactId: (r.contact_id as string) ?? null,
        contactName: contact?.name ?? "",
        contactPhone: contact?.phone ?? "",
        conversationId: null,
        state: AUTO_STATE[String(r.status)] ?? "running",
        startedAt: String(r.created_at),
        trigger: String(r.trigger_event ?? ""),
        detail: (r.error_message as string) ?? null,
        steps: (r.steps_executed as RunRow["steps"]) ?? [],
      });
    }
    out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    setRows(out);
    setLoading(false);
  }, [engine, days]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refetch on filter change
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (stateFilter === "all" || r.state === stateFilter) &&
        (!needle || [r.sourceName, r.contactName, r.contactPhone].some((v) => v.toLowerCase().includes(needle))),
    );
  }, [rows, q, stateFilter]);

  async function open(row: RunRow) {
    setSelected(row);
    setEvents(null);
    const supabase = createClient();
    if (row.engine === "flow") {
      const { data } = await supabase
        .from("flow_run_events")
        .select("id, event_type, node_key, payload, created_at")
        .eq("flow_run_id", row.id)
        .order("created_at", { ascending: true })
        .limit(500);
      setEvents((data ?? []) as FlowEvent[]);
    } else if (row.contactId && !row.conversationId) {
      const { data } = await supabase.from("conversations").select("id").eq("contact_id", row.contactId).limit(1);
      const conv = (data ?? [])[0] as { id: string } | undefined;
      if (conv) setSelected({ ...row, conversationId: conv.id });
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search")} className="pl-8" />
        </div>
        <select value={engine} onChange={(e) => setEngine(e.target.value as typeof engine)} className="h-9 rounded-md border border-border bg-muted px-2 text-sm" aria-label={t("engine")}>
          <option value="all">{t("allEngines")}</option>
          <option value="flow">{t("engines.flow")}</option>
          <option value="automation">{t("engines.automation")}</option>
        </select>
        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as typeof stateFilter)} className="h-9 rounded-md border border-border bg-muted px-2 text-sm" aria-label={t("status")}>
          <option value="all">{t("allStatuses")}</option>
          {(Object.keys(STATE_TONE) as RunState[]).filter((s) => s !== "running").map((s) => (
            <option key={s} value={s}>{t(`states.${s}`)}</option>
          ))}
        </select>
        <div className="flex rounded-lg border border-border p-0.5 text-sm">
          {RANGES.map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)} className={cn("rounded-md px-2.5 py-1", days === d ? "bg-primary/10 text-primary" : "text-muted-foreground")}>
              {t("lastDays", { days: d })}
            </button>
          ))}
        </div>
      </div>

      <div className="grid min-h-[520px] gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <ul className="divide-y divide-border overflow-y-auto rounded-xl border border-border bg-card lg:max-h-[70vh]">
          {loading ? (
            <li className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></li>
          ) : visible.length === 0 ? (
            <li className="py-10 text-center text-sm text-muted-foreground">{t("empty")}</li>
          ) : (
            visible.map((r) => (
              <li key={r.key}>
                <button type="button" onClick={() => void open(r)} className={cn("flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-muted/50", selected?.key === r.key && "bg-primary/5")}>
                  {r.engine === "flow" ? <Workflow className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : <Zap className="mt-0.5 h-4 w-4 shrink-0 text-violet-500" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{r.contactName || r.contactPhone || t("noContact")}</span>
                    <span className="block truncate text-xs text-muted-foreground">{r.sourceName}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className={cn("block rounded-full px-2 py-0.5 text-[10px]", STATE_TONE[r.state])}>{t(`states.${r.state}`)}</span>
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">{new Date(r.startedAt).toLocaleString()}</span>
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>

        <section className="rounded-xl border border-border bg-card p-4">
          {!selected ? (
            <p className="py-16 text-center text-sm text-muted-foreground">{t("pick")}</p>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold">{selected.sourceName}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`engines.${selected.engine}`)} · {t("trigger")}: {selected.trigger} · <code>{selected.id.slice(0, 8)}</code>
                  </p>
                </div>
                <div className="flex gap-2 text-xs">
                  <Link href={selected.engine === "flow" ? `/flows/${selected.sourceId}` : `/automations/${selected.sourceId}/edit`} className="inline-flex items-center gap-1 text-primary hover:underline">
                    <ExternalLink className="h-3.5 w-3.5" />
                    {t("openBuilder")}
                  </Link>
                  {selected.conversationId && (
                    <Link href={`/inbox?c=${selected.conversationId}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                      <MessageSquare className="h-3.5 w-3.5" />
                      {t("openChat")}
                    </Link>
                  )}
                </div>
              </div>
              <span className={cn("inline-block rounded-full px-2 py-0.5 text-xs", STATE_TONE[selected.state])}>{t(`states.${selected.state}`)}</span>
              {selected.detail && <p className="text-xs text-muted-foreground">{t("reason")}: {selected.detail}</p>}
              <ol className="space-y-2 border-l border-border pl-4">
                {selected.engine === "flow" ? (
                  events === null ? (
                    <li><Loader2 className="h-4 w-4 animate-spin text-primary" /></li>
                  ) : (
                    events.map((e) => (
                      <li key={e.id} className="text-xs">
                        <span className={cn("font-medium", e.event_type === "error" && "text-red-500")}>{t.has(`events.${e.event_type}`) ? t(`events.${e.event_type}`) : e.event_type}</span>
                        {e.node_key && <code className="ml-1 text-muted-foreground">{e.node_key}</code>}
                        <span className="ml-2 text-muted-foreground">{new Date(e.created_at).toLocaleTimeString()}</span>
                        {summarizePayload(e.payload) && <span className="block text-muted-foreground">{summarizePayload(e.payload)}</span>}
                      </li>
                    ))
                  )
                ) : (
                  (selected.steps ?? []).map((s, i) => (
                    <li key={i} className="text-xs">
                      <span className={cn("font-medium", s.status === "failed" && "text-red-500")}>{s.step_type}</span>
                      <span className="ml-2 text-muted-foreground">{s.status}</span>
                      {s.detail && <span className="block text-muted-foreground">{s.detail}</span>}
                    </li>
                  ))
                )}
              </ol>
              {selected.engine === "automation" && selected.state === "waiting_time" && (
                <p className="text-[11px] text-muted-foreground">{t("waitingNote")}</p>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** Safe one-line view of an event payload (no raw customer text is stored). */
function summarizePayload(p: Record<string, unknown>): string {
  const keys = ["reason", "detail", "condition_result", "working_hours", "assignment", "action", "advancing_to", "captured_key", "template", "opt_out", "ai"];
  return keys
    .filter((k) => p?.[k] !== undefined && p[k] !== null)
    .map((k) => `${k}: ${String(p[k]).slice(0, 120)}`)
    .join(" · ");
}
