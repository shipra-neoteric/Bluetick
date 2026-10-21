"use client";

/**
 * Insights → Analytics. Response metrics (two KPIs) and charts, each card
 * with its own agent/period filters. Numbers come from the canonical
 * Insights service.
 * The existing Dashboard is unchanged.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { formatDuration } from "@/lib/insights/format";
import { InsightCard, KpiCard, MembersProvider, timeZone } from "@/components/insights/insight-card";

function useJson<T>(url: string): { data: T | null; error: string | null; loading: boolean } {
  const [s, setS] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  useEffect(() => {
    const c = new AbortController();
    void (async () => {
      try {
        const res = await fetch(url, { signal: c.signal, cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (!c.signal.aborted) setS(res.ok ? { data: json as T, error: null, loading: false } : { data: null, error: json.error ?? `HTTP ${res.status}`, loading: false });
      } catch {
        if (!c.signal.aborted) setS({ data: null, error: "Network error", loading: false });
      }
    })();
    return () => c.abort();
  }, [url]);
  return s;
}

export default function AnalyticsPage() {
  const t = useTranslations("Insights");
  const tz = timeZone();
  const rt = useJson<{ total: number | null; samples?: number }>(`/api/insights/metric?metric=response_time&preset=today&tz=${encodeURIComponent(tz)}`);
  const pending = useJson<{ count: number }>(`/api/insights/pending?preset=last_7_days&tz=${encodeURIComponent(tz)}`);

  return (
    <MembersProvider>
      <div className="space-y-6 p-1">
        <header>
          <h1 className="text-2xl font-semibold">{t("analyticsTitle")}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t("analyticsSubtitle", { tz })}</p>
        </header>

        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">{t("responseMetrics")}</h2>
            <p className="text-muted-foreground text-xs">{t("responseMetricsHint")}</p>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <KpiCard
              title={t("kpiResponseTime")}
              value={rt.data ? (rt.data.samples ? formatDuration(rt.data.total) : t("noData")) : ""}
              unit={t("average")}
              scope={[t("allAgents"), t("presets.today"), t("samples", { count: rt.data?.samples ?? 0 })]}
              loading={rt.loading}
              error={rt.error ?? undefined}
            />
            <KpiCard
              title={t("kpiPending")}
              value={pending.data ? String(pending.data.count) : ""}
              unit={t("count")}
              scope={[t("allAgents"), t("waitingSinceLast7")]}
              loading={pending.loading}
              error={pending.error ?? undefined}
            />
          </div>
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">{t("charts")}</h2>
            <p className="text-muted-foreground text-xs">{t("chartsHint")}</p>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <InsightCard metric="opened" view="bars" defaultPreset="last_7_days" title={t("cards.opened")} description={t("cards.openedHint")} />
            <InsightCard metric="replied" view="bars" defaultPreset="yesterday" title={t("cards.replied")} description={t("cards.repliedHint")} />
            <InsightCard metric="closed" view="bars" defaultPreset="today" title={t("cards.closed")} description={t("cards.closedHint")} />
            <InsightCard metric="response_time" view="bars" defaultPreset="today" title={t("cards.responseTime")} description={t("cards.responseTimeHint")} />
            <InsightCard metric="replied" view="agent_pie" defaultPreset="today" title={t("cards.repliedByAgent")} description={t("cards.repliedByAgentHint")} />
            <InsightCard metric="response_time" view="agent_bars" defaultPreset="today" title={t("cards.responseByAgent")} description={t("cards.responseByAgentHint")} />
          </div>
          <p className="text-muted-foreground text-[11px]">{t("definitionsNote")}</p>
        </section>
      </div>
    </MembersProvider>
  );
}
