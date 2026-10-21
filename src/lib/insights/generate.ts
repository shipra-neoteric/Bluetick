/**
 * Report generation (RP-02/RP-05), shared by "Download excel" and
 * "Regenerate". One history row per request: Generating → Complete (file
 * stored, 7-day availability) or Failed (safe error). A duplicate active
 * request (same requester, type and parameters) is refused by the
 * database's unique index instead of running twice.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { loadMetric } from "./metrics";
import { resolvePeriod, type Preset } from "./period";
import { buildAgentActivityWorkbook, FILE_TTL_DAYS, REPORT_TYPES, reportFileName, type ReportType } from "./reports";

export interface ReportParams {
  preset: Preset;
  from?: string;
  to?: string;
  tz: string;
  agent_id?: string | null;
}

export type GenerateResult =
  | { ok: true; id: string }
  | { ok: false; status: number; code: string; error: string };

export function normalizeParams(p: ReportParams): { params: ReportParams; key: string } {
  const params: ReportParams = {
    preset: p.preset,
    ...(p.preset === "custom" ? { from: p.from, to: p.to } : {}),
    tz: p.tz,
    agent_id: p.agent_id || null,
  };
  return { params, key: JSON.stringify([params.preset, params.from ?? "", params.to ?? "", params.tz, params.agent_id ?? ""]) };
}

export async function generateReport(args: {
  userDb: SupabaseClient;
  accountId: string;
  userId: string;
  type: ReportType;
  params: ReportParams;
  regeneratedFrom?: string;
}): Promise<GenerateResult> {
  if (!REPORT_TYPES[args.type]) return { ok: false, status: 400, code: "unknown_type", error: "Unknown report." };
  const resolved = resolvePeriod({ preset: args.params.preset, from: args.params.from, to: args.params.to, tz: args.params.tz });
  if (!resolved.ok) return { ok: false, status: 400, code: "invalid_period", error: resolved.error };
  const period = resolved.period;
  const { params, key } = normalizeParams(args.params);

  const admin = supabaseAdmin();
  const { data: row, error: insErr } = await admin
    .from("report_requests")
    .insert({
      account_id: args.accountId,
      report_type: args.type,
      params,
      params_key: key,
      status: "generating",
      requested_by: args.userId,
      regenerated_from: args.regeneratedFrom ?? null,
    })
    .select("id")
    .single();
  if (insErr || !row) {
    if (insErr?.code === "23505") {
      return { ok: false, status: 409, code: "duplicate", error: "This report is already being generated." };
    }
    return { ok: false, status: 500, code: "insert_failed", error: insErr?.message ?? "Could not record the request." };
  }
  const id = (row as { id: string }).id;

  try {
    // The caller's own client: row-level security applies to the data too.
    const agent = params.agent_id ?? null;
    const [response, replied, opened, closed] = await Promise.all([
      loadMetric(args.userDb, args.accountId, "response_time", period, agent),
      loadMetric(args.userDb, args.accountId, "replied", period, agent),
      loadMetric(args.userDb, args.accountId, "opened", period, agent),
      loadMetric(args.userDb, args.accountId, "closed", period, agent),
    ]);
    const { data: members } = await admin
      .from("profiles")
      .select("user_id, full_name, email")
      .eq("account_id", args.accountId);
    const agentNames = new Map(
      ((members ?? []) as { user_id: string; full_name: string | null; email: string | null }[]).map((m) => [
        m.user_id,
        m.full_name || m.email || "Member",
      ]),
    );
    const bytes = buildAgentActivityWorkbook({
      period,
      generatedAt: new Date(),
      scopeLabel: agent ? `Agent: ${agentNames.get(agent) ?? agent}` : "All agents",
      agentNames,
      response,
      replied,
      opened,
      closed,
    });
    if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("The report is larger than 5 MB; choose a shorter period.");
    const { error: updErr } = await admin
      .from("report_requests")
      .update({
        status: "complete",
        completed_at: new Date().toISOString(),
        file_name: reportFileName(args.type, period),
        file_size: bytes.byteLength,
        file_data: `\\x${Buffer.from(bytes).toString("hex")}`,
        expires_at: new Date(Date.now() + FILE_TTL_DAYS * 86_400_000).toISOString(),
      })
      .eq("id", id);
    if (updErr) throw new Error(updErr.message);
    return { ok: true, id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await admin
      .from("report_requests")
      .update({ status: "failed", completed_at: new Date().toISOString(), error: msg.slice(0, 300) })
      .eq("id", id);
    return { ok: false, status: 500, code: "failed", error: "The report could not be generated. You can try again." };
  }
}

/** bytea from PostgREST arrives as "\x…" hex. */
export function decodeBytea(v: unknown): Uint8Array | null {
  if (typeof v !== "string" || !v.startsWith("\\x")) return null;
  return new Uint8Array(Buffer.from(v.slice(2), "hex"));
}
