/**
 * Flow simulator — walks the builder's draft graph with synthetic input,
 * a fake clock and mocked actions. Nothing is sent, assigned, tagged or
 * stored. Mirrors the runner's semantics (lib/flows/engine.ts): starts
 * on the trigger, auto-advances, waits at buttons / list / question
 * nodes, matches taps by reply id (never by label), applies the
 * fallback policy, ends at handoff / end.
 */

import { answerIsValid, evaluateConditionPredicate, matchReplyId, matchesKeywordTrigger } from "./matching";
import { BOT_STUDIO_SLOTS } from "./node-registry";
import { formatDate, formatPhone } from "@/lib/bot/formatters";
import { workingHoursAt, DEFAULT_BUSINESS_HOURS, type BusinessHours } from "@/lib/bot/working-hours";
import { interpolate } from "@/lib/bot/variables";
import { DEFAULT_FALLBACK_POLICY, isEventTrigger, type ConditionOperator, type FlowFallbackPolicy, type KeywordTriggerConfig } from "./types";

export interface SimNode {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

export interface SimFlow {
  trigger_type: import("@/lib/flows/types").FlowTriggerKind;
  trigger_config: Record<string, unknown>;
  entry_node_id: string | null;
  fallback_policy?: Partial<FlowFallbackPolicy>;
}

export type SimInput = { kind: "text"; text: string } | { kind: "tap"; reply_id: string; title?: string };

export interface SimContext {
  now: Date;
  contact: { name?: string; phone?: string; email?: string; company?: string };
  tagIds: string[];
  custom: Record<string, string>;
  businessHours?: BusinessHours;
  /** Mocked AI step result. */
  ai?: { text: string; handoff?: boolean };
  /** For the first-inbound trigger. */
  firstInbound?: boolean;
}

export type SimStepKind = "start" | "message" | "prompt" | "action" | "branch" | "input" | "fallback" | "end" | "error";

export interface SimStep {
  kind: SimStepKind;
  node_key?: string;
  node_type?: string;
  /** Plain-language detail (text sent, branch taken, mocked action). */
  detail: string;
  /** Buttons / rows offered at a prompt. */
  options?: { reply_id: string; title: string }[];
}

export interface SimResult {
  status: "not_started" | "waiting" | "completed" | "handed_off" | "failed";
  steps: SimStep[];
  vars: Record<string, unknown>;
  waitingAt: string | null;
}

const MAX_STEPS = 64;

export function simulateFlow(flow: SimFlow, nodes: SimNode[], inputs: SimInput[], ctx: SimContext): SimResult {
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  const policy = { ...DEFAULT_FALLBACK_POLICY, ...(flow.fallback_policy ?? {}) };
  const steps: SimStep[] = [];
  const vars: Record<string, unknown> = {};
  let current: string | null = null;
  let reprompts = 0;
  const fill = (t: unknown) =>
    interpolate(String(t ?? ""), { vars, contact: ctx.contact, custom: ctx.custom, message: { text: "" } });
  const result = (status: SimResult["status"]): SimResult => ({ status, steps, vars, waitingAt: status === "waiting" ? current : null });

  // ── start ──
  const first = inputs[0];
  if (!first) return result("not_started");
  const starts =
    flow.trigger_type === "manual" ||
    // Event triggers (ad click, conversation closed, webhook…): the first
    // simulated input stands for the event happening.
    isEventTrigger(flow.trigger_type) ||
    (flow.trigger_type === "first_inbound_message" && ctx.firstInbound !== false) ||
    (flow.trigger_type === "keyword" &&
      matchesKeywordTrigger(first.kind === "text" ? first.text : (first.title ?? first.reply_id), flow.trigger_config as unknown as KeywordTriggerConfig));
  if (!starts || !flow.entry_node_id) {
    steps.push({ kind: "error", detail: flow.entry_node_id ? "trigger_not_matched" : "no_entry" });
    return result("not_started");
  }
  steps.push({ kind: "start", detail: flow.trigger_type });

  // ── advance until a wait or the end ──
  const advance = (fromKey: string): SimResult["status"] => {
    let key: string | null = fromKey;
    for (let i = 0; i < MAX_STEPS; i++) {
      if (!key) {
        // Nothing connected after the last step: the flow ends there.
        steps.push({ kind: "end", detail: "completed" });
        return "completed";
      }
      const node = byKey.get(key);
      if (!node) {
        steps.push({ kind: "error", node_key: key, detail: "step_not_found" });
        return "failed";
      }
      const c = node.config;
      const base = { node_key: node.node_key, node_type: node.node_type };
      switch (node.node_type) {
        case "start":
          key = String(c.next_node_key ?? "");
          continue;
        case "send_message":
          steps.push({
            ...base,
            kind: "message",
            detail: c.media_url ? `[${c.media_type ?? "media"}] ${fill(c.text)}` : fill(c.text),
          });
          if (c.wait_reply) {
            // "On response": wait for the reply like a question.
            current = node.node_key;
            return "waiting";
          }
          key = String(c.next_node_key ?? "");
          continue;
        case "send_media":
          steps.push({ ...base, kind: "message", detail: `[${c.media_type ?? "media"}] ${fill(c.caption) || String(c.media_url ?? "")}` });
          key = String(c.next_node_key ?? "");
          continue;
        case "send_location":
          steps.push({ ...base, kind: "message", detail: `📍 ${fill(c.name) || ""} ${fill(c.latitude)},${fill(c.longitude)}`.trim() });
          key = String(c.next_node_key ?? "");
          continue;
        case "send_template":
          steps.push({ ...base, kind: "message", detail: `[template] ${c.template_name ?? ""} ${((c.params as string[]) ?? []).map(fill).join(" | ")}`.trim() });
          key = String(c.next_node_key ?? "");
          continue;
        case "send_buttons":
        case "send_list": {
          const options =
            node.node_type === "send_buttons"
              ? ((c.buttons as { reply_id: string; title: string }[]) ?? []).map((b) => ({ reply_id: b.reply_id, title: fill(b.title) }))
              : ((c.sections as { rows?: { reply_id: string; title: string }[] }[]) ?? []).flatMap((s) =>
                  (s.rows ?? []).map((r) => ({ reply_id: r.reply_id, title: fill(r.title) })),
                );
          steps.push({ ...base, kind: "prompt", detail: fill(c.text), options });
          current = node.node_key;
          return "waiting";
        }
        case "collect_input":
          steps.push({ ...base, kind: "prompt", detail: fill(c.prompt_text) });
          current = node.node_key;
          return "waiting";
        case "condition": {
          if (c.rule && typeof c.rule === "object") {
            const r = c.rule as { subject?: string; operand?: string; value?: string };
            let ok = false;
            if (r.subject === "tag_presence") ok = ctx.tagIds.includes(String(r.operand));
            else if (r.subject === "contact_field")
              ok = String((ctx.contact as Record<string, string | undefined>)[String(r.operand)] ?? "") === String(r.value ?? "");
            else if (r.subject === "message_content") {
              const text = first.kind === "text" ? first.text : (first.title ?? "");
              ok = text.toLowerCase().includes(String(r.value ?? "").toLowerCase());
            } else if (r.subject === "working_hours")
              ok = workingHoursAt(ctx.now, ctx.businessHours ?? DEFAULT_BUSINESS_HOURS) === "open";
            else if (r.subject === "time_of_day") {
              const [from, to] = String(r.operand ?? "").split("-");
              const mins = ctx.now.getHours() * 60 + ctx.now.getMinutes();
              const p = (x: string) => { const [hh, mm] = x.split(":").map(Number); return (hh || 0) * 60 + (mm || 0); };
              if (from && to) ok = p(from) <= p(to) ? mins >= p(from) && mins < p(to) : mins >= p(from) || mins < p(to);
            }
            steps.push({ ...base, kind: "branch", detail: ok ? "true" : "false" });
            key = String((ok ? c.true_next : c.false_next) ?? "");
            continue;
          }
          let subject: string | undefined;
          if (c.subject === "var") subject = vars[String(c.subject_key)] == null ? undefined : String(vars[String(c.subject_key)]);
          else if (c.subject === "tag") subject = ctx.tagIds.includes(String(c.subject_key)) ? String(c.subject_key) : undefined;
          else subject = (ctx.contact as Record<string, string | undefined>)[String(c.subject_key)] || undefined;
          const ok = evaluateConditionPredicate({
            operator: c.operator as ConditionOperator,
            subjectValue: subject,
            configValue: c.value as string | undefined,
          });
          steps.push({ ...base, kind: "branch", detail: ok ? "true" : "false" });
          key = String((ok ? c.true_next : c.false_next) ?? "");
          continue;
        }
        case "working_hours": {
          const state = workingHoursAt(ctx.now, ctx.businessHours ?? DEFAULT_BUSINESS_HOURS);
          steps.push({ ...base, kind: "branch", detail: state });
          key = String((state === "open" ? c.open_next : state === "holiday" && c.holiday_next ? c.holiday_next : c.closed_next) ?? "");
          continue;
        }
        case "set_tag":
          steps.push({ ...base, kind: "action", detail: `${c.mode === "remove" ? "remove" : "add"} tag ${c.tag_id ?? ""}` });
          key = String(c.next_node_key ?? "");
          continue;
        case "set_field":
          steps.push({ ...base, kind: "action", detail: `${c.field} ${c.mode === "clear" ? "cleared" : `= ${fill(c.value)}`}` });
          key = String(c.next_node_key ?? "");
          continue;
        case "assign_agent":
          steps.push({ ...base, kind: "action", detail: `assign (${c.mode ?? "round_robin"}${c.reassign ? ", reassign" : ""})` });
          key = String(c.next_node_key ?? "");
          continue;
        case "opt_out":
          steps.push({ ...base, kind: "action", detail: "opt out of marketing" });
          key = String(c.next_node_key ?? "");
          continue;
        case "format_value": {
          const input = fill(c.input);
          const res =
            c.kind === "phone"
              ? formatPhone(input, { defaultCountryCode: c.default_country_code as string, output: c.phone_output as "e164" })
              : formatDate(input, {
                  inputFormat: c.input_format as "auto",
                  inputTimezone: c.input_timezone as string,
                  outputFormat: String(c.output_format || "DD MMM YYYY"),
                  outputTimezone: c.output_timezone as string,
                });
          if (!res.ok) {
            steps.push({ ...base, kind: "branch", detail: `invalid: ${res.error}` });
            if (c.error_next) {
              key = String(c.error_next);
              continue;
            }
            return "failed";
          }
          vars[String(c.output_var)] = res.value;
          steps.push({ ...base, kind: "action", detail: `vars.${c.output_var} = ${res.value}` });
          key = String(c.next_node_key ?? "");
          continue;
        }
        case "ai_reply": {
          const ai = ctx.ai ?? { text: "(AI answer)" };
          if (ai.handoff) {
            steps.push({ ...base, kind: "branch", detail: "ai_handoff" });
            key = String(c.handoff_next || c.next_node_key || "");
            continue;
          }
          if (c.output_var) vars[String(c.output_var)] = ai.text;
          if (c.send !== false) steps.push({ ...base, kind: "message", detail: ai.text });
          key = String(c.next_node_key ?? "");
          continue;
        }
        case "time_delay":
          steps.push({ ...base, kind: "action", detail: `wait ${c.amount} ${c.unit} (skipped in the test)` });
          key = String(c.next_node_key ?? "");
          continue;
        case "wait_until":
          steps.push({ ...base, kind: "action", detail: `wait until ${fill(c.at)} (skipped in the test)` });
          key = String(c.next_node_key ?? "");
          continue;
        case "action":
          // Automation actions have side effects (deals, webhooks…); the
          // test only says what would run.
          steps.push({ ...base, kind: "action", detail: `would run: ${String(c.step_type)}` });
          key = String(c.next_node_key ?? "");
          continue;
        case "handoff":
          steps.push({ ...base, kind: "end", detail: "handed_off" });
          return "handed_off";
        case "end":
          steps.push({ ...base, kind: "end", detail: "completed" });
          return "completed";
        default:
          if (BOT_STUDIO_SLOTS[node.node_type]) {
            key = String(c.next_node_key ?? "");
            continue;
          }
          steps.push({ ...base, kind: "error", detail: `unknown_step:${node.node_type}` });
          return "failed";
      }
    }
    steps.push({ kind: "error", detail: "loop_limit" });
    return "failed";
  };

  let status = advance(flow.entry_node_id);

  // ── replies ──
  for (const input of inputs.slice(1)) {
    if (status !== "waiting" || !current) break;
    const node = byKey.get(current)!;
    steps.push({ kind: "input", detail: input.kind === "text" ? input.text : `tap: ${input.title ?? input.reply_id}` });
    let next: string | null = null;
    if (input.kind === "tap" && (node.node_type === "send_buttons" || node.node_type === "send_list")) {
      next = matchReplyId(node, input.reply_id);
    } else if (input.kind === "text" && node.node_type === "collect_input") {
      const v = input.text.trim();
      const cfg = node.config as { var_key?: string; enforce_validation?: boolean; validation?: "any"; regex?: string; next_node_key?: string };
      if (v && cfg.var_key && (!cfg.enforce_validation || answerIsValid(v, cfg))) {
        vars[cfg.var_key] = v;
        next = String(cfg.next_node_key ?? "");
      }
    }
    if (next === null && node.node_type === "send_message" && node.config.wait_reply) {
      const answer = input.kind === "text" ? input.text.trim() : String(input.title ?? input.reply_id);
      if (node.config.reply_var) vars[String(node.config.reply_var)] = answer;
      next = String(node.config.next_node_key ?? "");
    }
    // Buttons / list "Any other reply" output.
    if (next === null && (node.node_type === "send_buttons" || node.node_type === "send_list") && node.config.other_next) {
      vars.last_reply = input.kind === "text" ? input.text.trim() : String(input.title ?? input.reply_id);
      next = String(node.config.other_next);
    }
    if (next !== null) {
      reprompts = 0;
      status = advance(next);
      continue;
    }
    reprompts++;
    const action =
      policy.on_unknown_reply === "ignore"
        ? "ignore"
        : policy.on_unknown_reply === "handoff"
          ? "handoff"
          : reprompts <= policy.max_reprompts
            ? "reprompt"
            : policy.on_exhaust;
    steps.push({ kind: "fallback", node_key: current, detail: action });
    if (action === "handoff") {
      status = "handed_off";
    } else if (action === "end") {
      status = "completed";
    }
    // reprompt / ignore: still waiting at the same step
  }
  return result(status);
}
