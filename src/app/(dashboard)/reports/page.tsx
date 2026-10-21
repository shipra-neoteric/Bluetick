"use client";

/**
 * Insights → Reports (RP-01..05). The Agent activity report (date range →
 * Download excel) and the request history. Admins and owners only. It
 * uses the same Insights service as Analytics. Expired files offer
 * Regenerate (a new request with the stored settings).
 */

import { useCallback, useEffect, useState } from "react";
import { Download, FileSpreadsheet, Loader2, RotateCcw, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MembersProvider, PeriodSelect, timeZone, useAgentName, type PeriodValue } from "@/components/insights/insight-card";

interface HistoryRow {
  id: string;
  report_type: string;
  params: { preset: string; from?: string; to?: string; tz: string };
  status: "queued" | "generating" | "complete" | "failed";
  error: string | null;
  requested_by: string | null;
  requested_at: string;
  file_name: string | null;
  expires_at: string | null;
}

async function saveDownload(id: string): Promise<{ ok: true } | { ok: false; code?: string; error: string }> {
  const res = await fetch(`/api/reports/${id}/download`, { cache: "no-store" });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    return { ok: false, code: j.code, error: j.error ?? `HTTP ${res.status}` };
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "report.xlsx";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5_000);
  return { ok: true };
}

export default function ReportsPage() {
  return (
    <MembersProvider>
      <ReportsInner />
    </MembersProvider>
  );
}

function ReportsInner() {
  const t = useTranslations("Insights.reports");
  const agentName = useAgentName();
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "forbidden" | "missing" | "error">("loading");
  const [tick, setTick] = useState(0);
  // Time used for "Expired" badges, refreshed with every history load.
  const [now, setNow] = useState(() => Date.now());
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/reports", { cache: "no-store" });
        const j = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.status === 403) return setState("forbidden");
        if (!res.ok) return setState("error");
        if (j.available === false) return setState("missing");
        setHistory(j.history ?? []);
        setNow(Date.now());
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const download = async (row: HistoryRow) => {
    const r = await saveDownload(row.id);
    if (!r.ok) toast.error(r.code === "expired" ? t("expiredToast") : r.error);
  };
  const regenerate = async (row: HistoryRow) => {
    const res = await fetch(`/api/reports/${row.id}/regenerate`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    reload();
    if (!res.ok) return toast.error(j.error ?? t("failedToast"));
    toast.success(t("ready"));
    await saveDownload(j.id);
  };

  if (state === "forbidden") return <p className="text-muted-foreground p-6 text-sm">{t("adminsOnly")}</p>;

  return (
    <div className="space-y-6 p-1">
      <header>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("subtitle")}</p>
      </header>
      {state === "missing" && <p className="text-sm text-amber-600">{t("needsMigration")}</p>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ReportCard type="agent_activity" icon={Users} onDone={reload} disabled={state !== "ready"} />
      </div>

      <section>
        <h2 className="mb-2 text-base font-semibold">{t("history")}</h2>
        {state === "loading" ? (
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        ) : state === "error" ? (
          <button type="button" onClick={reload} className="text-primary text-sm hover:underline">{t("retryLoad")}</button>
        ) : !history?.length ? (
          <p className="text-muted-foreground rounded-lg border border-dashed py-8 text-center text-sm">{t("noHistory")}</p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-xl border">
            {history.map((row) => {
              const expired = row.status === "complete" && (!row.expires_at || Date.parse(row.expires_at) <= now);
              return (
                <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <FileSpreadsheet className="h-5 w-5 shrink-0 text-emerald-600" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{row.file_name ?? t("types.agent_activity.title")}</div>
                    <div className="text-muted-foreground text-xs">
                      {t("requestedOn", { at: new Date(row.requested_at).toLocaleString() })} · {t("requestedBy", { name: agentName(row.requested_by) })}
                    </div>
                    {row.status === "failed" && row.error && <div className="text-xs text-red-500">{t("failedReason")}</div>}
                  </div>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-medium",
                      row.status === "failed"
                        ? "bg-red-500/10 text-red-600"
                        : row.status === "complete"
                          ? expired
                            ? "bg-muted text-muted-foreground"
                            : "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
                          : "bg-amber-500/10 text-amber-600",
                    )}
                  >
                    {row.status === "complete" ? (expired ? t("status.expired") : t("status.complete")) : t(`status.${row.status}`)}
                  </span>
                  {row.status === "complete" && !expired && (
                    <Button variant="ghost" size="sm" onClick={() => void download(row)} aria-label={t("download")} title={t("download")}>
                      <Download className="h-4 w-4" />
                    </Button>
                  )}
                  {(expired || row.status === "failed") && (
                    <Button variant="outline" size="sm" onClick={() => void regenerate(row)}>
                      <RotateCcw className="h-3.5 w-3.5" /> {t("regenerate")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function ReportCard({
  type,
  icon: Icon,
  onDone,
  disabled,
}: {
  type: "agent_activity";
  icon: typeof Users;
  onDone: () => void;
  disabled?: boolean;
}) {
  const t = useTranslations("Insights.reports");
  const [period, setPeriod] = useState<PeriodValue | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = Boolean(period && (period.preset !== "custom" || (period.from && period.to && period.from <= period.to)));

  const run = async () => {
    if (!period || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ...period, tz: timeZone() }),
      });
      const j = await res.json().catch(() => ({}));
      onDone();
      if (!res.ok) {
        toast.error(j.error ?? t("failedToast"));
        return;
      }
      const d = await saveDownload(j.id);
      if (!d.ok) toast.error(d.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="border-border bg-card flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-600/10 text-emerald-700 dark:text-emerald-400">
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <h3 className="text-sm font-semibold">{t(`types.${type}.title`)}</h3>
          <p className="text-muted-foreground text-xs">{t(`types.${type}.description`)}</p>
        </div>
      </div>
      <PeriodSelect value={period} onChange={setPeriod} allowEmpty />
      {period?.preset === "custom" && period.from && period.to && period.from > period.to && <p className="text-xs text-red-500">{t("badRange")}</p>}
      <Button onClick={() => void run()} disabled={disabled || !valid || busy} className="self-start bg-emerald-600 text-white hover:bg-emerald-700">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        {busy ? t("generating") : t("downloadExcel")}
      </Button>
    </section>
  );
}
