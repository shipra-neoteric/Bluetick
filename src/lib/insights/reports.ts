/**
 * Reports (RP-01..05): the registry of report types and the workbook
 * builders. Agent activity reuses the Insights service, so a report and
 * the Analytics page agree for the same scope.
 */

import * as XLSX from "xlsx";
import { formatDuration } from "./format";
import type { MetricResult } from "./metrics";
import type { Period } from "./period";

export const REPORT_TYPES = {
  agent_activity: { available: true as const },
};
export type ReportType = keyof typeof REPORT_TYPES;
export const FILE_TTL_DAYS = 7;
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Spreadsheet-safe text: a leading = + - @ (or tab/CR) can't run as a formula. */
export function safeText(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export interface AgentActivityInput {
  period: Period;
  generatedAt: Date;
  scopeLabel: string;
  agentNames: Map<string, string>;
  response: MetricResult;
  replied: MetricResult;
  opened: MetricResult;
  closed: MetricResult;
}

const round1 = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

export function buildAgentActivityWorkbook(input: AgentActivityInput): Uint8Array {
  const { period, response, replied, opened, closed } = input;
  const name = (id: string | null) => (id ? safeText(input.agentNames.get(id) ?? "Former member") : "Unassigned / unknown");
  const lastDay = period.days[period.days.length - 1];

  const summary: (string | number | null)[][] = [
    ["Report", "Agent activity"],
    ["Period (first day)", period.days[0]],
    ["Period (last day)", lastDay],
    ["Time zone", period.tz],
    ["Scope", safeText(input.scopeLabel)],
    ["Generated at (UTC)", input.generatedAt.toISOString()],
    ["Definitions version", response.version],
    ["Lifecycle history since", response.history_since ?? "—"],
    [],
    ["Definitions"],
    ["Conversations replied", "Distinct conversations with a delivered human reply. Per agent: credited to the first human who replied in the period."],
    ["Response time", "First human reply per customer waiting episode (bot/flow/AI replies excluded). Average = total seconds ÷ samples."],
    ["Opened / closed", "Open (created or reopened) and close events, credited to the agent assigned at that moment."],
    [],
    ["Totals", "Value"],
    ["Conversations replied", replied.total ?? 0],
    ["Response samples", response.samples ?? 0],
    ["Total response seconds", round1(response.total_seconds ?? 0)],
    ["Average response seconds", round1(response.total)],
    ["Average response", formatDuration(response.total)],
    ["Conversations opened", opened.total ?? 0],
    ["Conversations closed", closed.total ?? 0],
  ];

  // One row per agent seen in any metric (plus Unassigned / unknown).
  const ids = new Set<string | null>();
  for (const m of [response, replied, opened, closed]) for (const r of m.by_agent) ids.add(r.agent_id);
  const find = (m: MetricResult, id: string | null) => m.by_agent.find((r) => r.agent_id === id);
  const agents: (string | number | null)[][] = [
    ["Agent ID", "Agent", "Conversations replied (first replier)", "Response samples", "Total response seconds", "Average response seconds", "Conversations opened", "Conversations closed"],
    ...[...ids]
      .map((id) => {
        const rt = find(response, id);
        return [
          id ?? "",
          name(id),
          find(replied, id)?.value ?? 0,
          rt?.samples ?? 0,
          round1(rt?.total_seconds ?? 0),
          rt && rt.samples ? round1(rt.value) : null,
          find(opened, id)?.value ?? 0,
          find(closed, id)?.value ?? 0,
        ];
      })
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
  ];

  const detail: (string | number | null)[][] = [
    [period.bucket === "hour" ? "Hour" : "Date", "Conversations replied", "Response samples", "Average response seconds", "Conversations opened", "Conversations closed"],
    ...response.series.map((p, i) => [
      p.bucket,
      replied.series[i]?.value ?? 0,
      p.samples ?? 0,
      round1(p.value),
      opened.series[i]?.value ?? 0,
      closed.series[i]?.value ?? 0,
    ]),
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), "Summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(agents), "Agents");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detail), period.bucket === "hour" ? "Hourly" : "Daily");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

export function reportFileName(type: ReportType, period: Period): string {
  const last = period.days[period.days.length - 1];
  return `${type.replace(/_/g, "-")}_${period.days[0]}_to_${last}.xlsx`;
}
