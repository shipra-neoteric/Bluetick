/**
 * Insights service — the one place analytics numbers come from. The
 * Analytics page and the Excel reports both call this, so for the same
 * scope they show the same values. Definitions live in SQL
 * (insights_metric, migration 050).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { CUSTOMER_WINDOW_MS } from "@/lib/whatsapp/send-message";
import { bucketKeys, type Period } from "./period";

export const METRICS = ["response_time", "replied", "opened", "closed"] as const;
export type Metric = (typeof METRICS)[number];
export const DEFINITION_VERSION = "insights-v1";

export interface SeriesPoint {
  bucket: string;
  /** Count, or average seconds; null = no samples (durations only). */
  value: number | null;
  samples?: number;
}
export interface AgentRow {
  agent_id: string | null;
  value: number;
  samples?: number;
  total_seconds?: number;
}
export interface MetricResult {
  metric: Metric;
  version: string;
  series: SeriesPoint[];
  /** Period total: count, or weighted average seconds (null = no samples). */
  total: number | null;
  samples?: number;
  total_seconds?: number;
  by_agent: AgentRow[];
  /** Assignment/lifecycle history starts here (migration 044). */
  history_since: string | null;
}

interface RawResult {
  series: { bucket: string; value: number; samples?: number }[];
  total: number | null;
  samples?: number;
  total_seconds?: number;
  by_agent: AgentRow[];
  version: string;
  history_since: string | null;
}

/**
 * Fill every bucket of the period: counts get a real 0, durations get
 * null ("no data"), never 0 seconds.
 */
export function fillSeries(metric: Metric, period: Period, raw: RawResult["series"]): SeriesPoint[] {
  const byKey = new Map(raw.map((p) => [p.bucket, p]));
  return bucketKeys(period).map((bucket) => {
    const hit = byKey.get(bucket);
    if (metric === "response_time") return { bucket, value: hit ? Number(hit.value) : null, samples: hit?.samples ?? 0 };
    return { bucket, value: hit ? Number(hit.value) : 0 };
  });
}

export async function loadMetric(
  db: SupabaseClient,
  accountId: string,
  metric: Metric,
  period: Period,
  agentId: string | null,
): Promise<MetricResult> {
  const { data, error } = await db.rpc("insights_metric", {
    p_account: accountId,
    p_metric: metric,
    p_from: period.from.toISOString(),
    p_to: period.to.toISOString(),
    p_tz: period.tz,
    p_bucket: period.bucket,
    p_agent: agentId,
  });
  if (error) throw new Error(error.message);
  const raw = data as RawResult;
  return {
    metric,
    version: raw.version ?? DEFINITION_VERSION,
    series: fillSeries(metric, period, raw.series ?? []),
    total: raw.total === null || raw.total === undefined ? (metric === "response_time" ? null : 0) : Number(raw.total),
    samples: raw.samples,
    total_seconds: raw.total_seconds,
    by_agent: (raw.by_agent ?? []).map((r) => ({ ...r, value: Number(r.value) })),
    history_since: raw.history_since,
  };
}

/**
 * Pending replies with the window open: conversations awaiting a human
 * reply (the inbox's own `awaiting_reply_since`) whose WhatsApp window is
 * open per the canonical CUSTOMER_WINDOW_MS rule, waiting since `since`.
 * Agent = currently assigned (snapshot).
 */
export async function loadPendingWithWindow(
  db: SupabaseClient,
  accountId: string,
  since: Date,
  agentId: string | null,
  now: Date = new Date(),
): Promise<number> {
  let q = db
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .neq("status", "closed")
    .not("awaiting_reply_since", "is", null)
    .gte("awaiting_reply_since", since.toISOString())
    .gt("last_inbound_at", new Date(now.getTime() - CUSTOMER_WINDOW_MS).toISOString());
  if (agentId) q = q.eq("assigned_agent_id", agentId);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export { formatDuration } from "./format";
