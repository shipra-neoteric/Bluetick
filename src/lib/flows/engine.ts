/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { supabaseAdmin } from "./admin-client";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import {
  engineSendLocation,
  engineSendTemplate,
} from "@/lib/automations/meta-send";
import {
  assignConversation,
  loadBusinessHours,
  loadContactScope,
  optOutContact,
  setContactField,
} from "@/lib/bot/actions";
import { planWaitUntil, workingHoursAt } from "@/lib/bot/working-hours";
import { performApiCall, type ApiDefinition } from "@/lib/bot/call-api";
import { isMissingSchemaError } from "@/lib/db/schema-compat";
import { formatDate, formatPhone } from "@/lib/bot/formatters";
import { interpolate as interpolateScope, needsContact } from "@/lib/bot/variables";
import { runAiStep } from "@/lib/bot/ai-step";
import { addContactTagAndDispatch } from "@/lib/contacts/tag-events";
import { removeContactTag } from "@/lib/contacts/tag-write";
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
  type SendLocationNodeConfig,
  type SendTemplateNodeConfig,
  type AssignAgentNodeConfig,
  type SetFieldNodeConfig,
  type WorkingHoursNodeConfig,
  type FormatValueNodeConfig,
  type AiReplyNodeConfig,
  type ActionNodeConfig,
  type TimeDelayNodeConfig,
  type WaitUntilNodeConfig,
  type CallApiNodeConfig,
  type GoogleSheetsNodeConfig,
  isEventTrigger,
} from "./types";

// ============================================================
// Pure helpers live in ./matching (shared with the browser
// simulator); re-exported here for existing imports and tests.
// ============================================================

import {
  answerIsValid,
  entryTriggerTexts,
  evaluateConditionPredicate,
  matchReplyId,
  matchesKeywordTrigger,
} from "./matching";
export { answerIsValid, entryTriggerTexts, evaluateConditionPredicate, matchReplyId, matchesKeywordTrigger };

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "condition" ||
    node_type === "set_tag" ||
    node_type === "action" ||
    BOT_STUDIO_AUTO_NODES.has(node_type)
  );
}

/** Nodes that park the run until a time (migration 048). */
export function isDelayNode(node_type: string): boolean {
  return node_type === "time_delay" || node_type === "wait_until";
}

/** Bot Studio nodes (migration 047) — all run and move on immediately. */
export const BOT_STUDIO_AUTO_NODES = new Set([
  "send_location",
  "send_template",
  "assign_agent",
  "set_field",
  "working_hours",
  "opt_out",
  "format_value",
  "ai_reply",
  "call_api",
  "google_sheets",
]);

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  // Migration 048: background runs (event flows, runs parked on a delay)
  // don't hold the conversation, so they never receive replies.
  const base = () =>
    db
      .from("flow_runs")
      .select("*")
      .eq("account_id", accountId)
      .eq("contact_id", contactId)
      .eq("status", "active");
  let { data, error } = await base()
    .eq("exclusive", true)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error && isMissingSchemaError(error)) {
    ({ data, error } = await base().order("started_at", { ascending: false }).limit(1));
  }
  if (error) {
    console.error("[flows] loadActiveRunForContact error:", error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadFlow error:", error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(
  db: AdminClient,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId);
  if (error) {
    console.error("[flows] loadAllNodes error:", error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

/** A published snapshot (migration 047). */
interface FlowVersionRow {
  flow_id: string;
  version: number;
  entry_node_id: string | null;
  trigger_type: FlowRow["trigger_type"];
  trigger_config: FlowRow["trigger_config"];
  fallback_policy: FlowRow["fallback_policy"] | null;
  nodes: Array<Pick<FlowNodeRow, "node_key" | "node_type" | "config"> & Partial<FlowNodeRow>>;
}

function nodesFromVersion(v: FlowVersionRow): Map<string, FlowNodeRow> {
  const map = new Map<string, FlowNodeRow>();
  for (const n of v.nodes ?? []) {
    map.set(n.node_key, {
      id: n.id ?? n.node_key,
      flow_id: v.flow_id,
      node_key: n.node_key,
      node_type: n.node_type,
      config: n.config ?? {},
      position_x: n.position_x ?? 0,
      position_y: n.position_y ?? 0,
      created_at: n.created_at ?? "",
    });
  }
  return map;
}

async function loadVersion(
  db: AdminClient,
  flowId: string,
  version: number,
): Promise<FlowVersionRow | null> {
  const { data, error } = await db
    .from("flow_versions")
    .select("flow_id, version, entry_node_id, trigger_type, trigger_config, fallback_policy, nodes")
    .eq("flow_id", flowId)
    .eq("version", version)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadVersion error:", error.message);
    return null;
  }
  return (data as FlowVersionRow | null) ?? null;
}

/** Nodes a run executes: its pinned version, else the live nodes. */
async function loadNodesForRun(
  db: AdminClient,
  run: FlowRunRow,
): Promise<Map<string, FlowNodeRow>> {
  if (run.flow_version) {
    const v = await loadVersion(db, run.flow_id, run.flow_version);
    if (v) return nodesFromVersion(v);
  }
  return loadAllNodes(db, run.flow_id);
}

/**
 * What a flow looks like to the runtime: the published snapshot when
 * one exists, otherwise the live row (flows published before 047).
 */
interface RuntimeFlow {
  flow: FlowRow;
  version: FlowVersionRow | null;
}

async function loadRuntimeFlows(db: AdminClient, accountId: string): Promise<RuntimeFlow[]> {
  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !flows) return [];
  const typed = flows as FlowRow[];
  const versioned = typed.filter((f) => f.published_version);
  const versions = new Map<string, FlowVersionRow>();
  if (versioned.length) {
    const { data } = await db
      .from("flow_versions")
      .select("flow_id, version, entry_node_id, trigger_type, trigger_config, fallback_policy, nodes")
      .in("flow_id", versioned.map((f) => f.id));
    for (const v of (data ?? []) as FlowVersionRow[]) {
      const f = versioned.find((x) => x.id === v.flow_id);
      if (f && f.published_version === v.version) versions.set(v.flow_id, v);
    }
  }
  return typed.map((flow) => {
    const version = versions.get(flow.id) ?? null;
    return {
      flow: version
        ? {
            ...flow,
            trigger_type: version.trigger_type,
            trigger_config: version.trigger_config,
            entry_node_id: version.entry_node_id,
            fallback_policy: version.fallback_policy ?? flow.fallback_policy,
          }
        : flow,
      version,
    };
  });
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", error.message);
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .in("flow_run_id", runIds)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", metaMessageId);
  return (count ?? 0) > 0;
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
): Promise<RuntimeFlow | null> {
  // A tap used to be rejected outright here, on the reasoning that
  // interactive replies are responses to existing prompts. That holds
  // only while a prompt is outstanding — and this function runs solely
  // when the contact has NO active run, so there is nothing the tap
  // could be answering. What it actually blocked was issue #490: an
  // *automation* sends the buttons, the customer taps one, and the flow
  // whose keyword matches that button never starts. Retyping the label
  // by hand worked, which is the tell — same words, different envelope.
  const candidates = entryTriggerTexts(message);

  // Pull all active flows for this account (published snapshot when
  // there is one). Active set is bounded; partial index supports it.
  const runtime = await loadRuntimeFlows(db, accountId);
  for (const rf of runtime) {
    const flow = rf.flow;
    if (flow.trigger_type === "keyword") {
      const cfg = flow.trigger_config as KeywordTriggerConfig;
      if (candidates.some((text) => matchesKeywordTrigger(text, cfg))) {
        return rf;
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      // Also reachable by a tap now: a broadcast template with a
      // quick-reply button can genuinely be what prompts a contact's
      // first-ever inbound. The automations dispatcher has always
      // treated a tap that way (the webhook pushes
      // `first_inbound_message` regardless of envelope) — flows were
      // the inconsistent half.
      return rf;
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }
  return null;
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  // Every customer-visible string is interpolated against run.vars —
  // same treatment send_message / collect_input already get (#553).
  // `reply_id` is deliberately NOT interpolated: it is the routing key
  // matchReplyId compares the tapped button against, so it must reach
  // Meta byte-for-byte as authored. Interpolation can push a title past
  // Meta's 20-char cap; meta-api's validator throws a descriptive error
  // and the caller logs it — we never truncate silently.
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars),
    headerText: cfg.header_media_url ? undefined : interpolateOptionalVars(cfg.header_text, run.vars),
    headerMedia: cfg.header_media_url
      ? { type: cfg.header_media_type ?? "image", link: interpolateVars(cfg.header_media_url, run.vars) }
      : undefined,
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars),
    buttons: cfg.buttons.map((b) => ({
      id: b.reply_id,
      title: interpolateVars(b.title, run.vars),
    })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  // Look up our internal message id so we can stash it on the run.
  // Cheap — indexed on `messages.message_id`.
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  // See sendButtonsAndSuspend — interpolate every visible string,
  // never the row `reply_id`.
  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars),
    buttonLabel: interpolateVars(cfg.button_label, run.vars),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars),
    sections: cfg.sections.map((s) => ({
      title: interpolateOptionalVars(s.title, run.vars),
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: interpolateVars(r.title, run.vars),
        description: interpolateOptionalVars(r.description, run.vars),
      })),
    })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_list",
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  const convUpdate: Record<string, unknown> = {
    status: "pending",
    updated_at: new Date().toISOString(),
  };
  if (cfg.assign_to) convUpdate.assigned_agent_id = cfg.assign_to;
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update(convUpdate)
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
  });
  await endRun(db, run.id, "handed_off", "handoff_node");
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const v = run.vars[cfg.subject_key];
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    const { count } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", cfg.subject_key);
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    subjectValue = (count ?? 0) > 0 ? cfg.subject_key : undefined;
  } else {
    const ALLOWED = ["name", "email", "phone", "company"] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const { data } = await db
      .from("contacts")
      .select(cfg.subject_key)
      .eq("id", run.contact_id!)
      .maybeSingle();
    const raw = (data as Record<string, unknown> | null)?.[cfg.subject_key];
    subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template
    .replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
      const v = vars[key];
      return v === undefined || v === null ? "" : String(v);
    })
    // Event payload (sheet row, ad details, webhook body): {{trigger.a.b}}.
    .replace(/\{\{\s*(trigger(?:\.[\w-]+)+)\s*\}\}/g, (_, token: string) =>
      interpolateScope(`{{${token}}}`, { trigger: triggerOf(vars) }),
    );
}

function triggerOf(vars: Record<string, unknown> | null | undefined): Record<string, unknown> | undefined {
  const t = vars?.trigger;
  return t && typeof t === "object" ? (t as Record<string, unknown>) : undefined;
}

/**
 * `interpolateVars` for optional config fields (header_text, footer_text,
 * list section titles, row descriptions). An absent field stays absent
 * — `interpolateVars(undefined)` would return "" and meta-api treats
 * header/footer/description by truthiness, so "" is harmless there, but
 * keeping `undefined` means the payload we log and send matches what
 * the author configured rather than sprouting empty strings.
 */
function interpolateOptionalVars(
  template: string | undefined,
  vars: Record<string, unknown>,
): string | undefined {
  return template === undefined || template === null
    ? undefined
    : interpolateVars(template, vars);
}

async function endRun(
  db: AdminClient,
  runId: string,
  status: "completed" | "handed_off" | "timed_out" | "failed",
  reason: string,
): Promise<void> {
  await db
    .from("flow_runs")
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq("id", runId);
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  let currentKey: string | null = startNodeKey;
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      // Nothing connected after the last step: the flow simply ends here
      // (the Bot Studio convention). Used to be a failure.
      await logEvent(db, run.id, "completed", null, { reason: "end_of_path" });
      await endRun(db, run.id, "completed", "end_of_path");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(db, run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      // "On response" (Bot Builder): this message waits for the reply,
      // so it must hold the conversation before it is sent.
      if (cfg.wait_reply && !(await holdConversation(db, run, node.node_key))) return { outcome: "completed" };
      try {
        const { whatsapp_message_id } = cfg.media_url
          ? await engineSendMedia({
              accountId: run.account_id,
              userId: run.user_id,
              conversationId: run.conversation_id!,
              contactId: run.contact_id!,
              kind: cfg.media_type === "audio" ? "document" : (cfg.media_type ?? "image"),
              link: interpolateVars(cfg.media_url, run.vars),
              caption: cfg.text ? interpolateVars(cfg.text, run.vars) : undefined,
              filename: cfg.filename,
            })
          : await engineSendText({
              accountId: run.account_id,
              userId: run.user_id,
              conversationId: run.conversation_id!,
              contactId: run.contact_id!,
              text: interpolateVars(cfg.text, run.vars),
            });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      if (cfg.wait_reply) {
        // Suspend here; the customer's next message is captured by
        // handleReplyForActiveRun (send_message branch).
        const advanced = await advanceCurrentNodeKey(db, run.id, run.current_node_key, node.node_key);
        if (!advanced) {
          await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
        }
        return { outcome: "advanced" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars)
            : undefined,
          filename: cfg.filename,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "collect_input") {
      if (!(await holdConversation(db, run, node.node_key))) return { outcome: "completed" };
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "collect_input",
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from("messages")
          .select("id")
          .eq("message_id", whatsapp_message_id)
          .maybeSingle();
        await db
          .from("flow_runs")
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq("id", run.id);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (cfg.rule
          ? await evaluateRuleForRun(run, cfg.rule)
          : await evaluateConditionNode(db, run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        const tagIds = cfg.tag_ids?.length ? cfg.tag_ids : cfg.tag_id ? [cfg.tag_id] : [];
        for (const tagId of tagIds) {
          if (cfg.mode === "add") {
            await addContactTagAndDispatch({
              db,
              accountId: run.account_id,
              contactId: run.contact_id!,
              tagId,
              context: {
                conversation_id: run.conversation_id ?? undefined,
                vars: run.vars,
              },
            });
          } else {
            await removeContactTag(db, {
              accountId: run.account_id,
              contactId: run.contact_id!,
              tagId,
            });
          }
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      if (!(await holdConversation(db, run, node.node_key))) return { outcome: "completed" };
      // Same failure contract as send_message / send_media /
      // collect_input above: log + fail the run. Previously an
      // exception here (Meta error, or meta-api's length validation —
      // now reachable via interpolation, see sendButtonsAndSuspend)
      // escaped to dispatchInboundToFlows' catch, which only
      // console.error'd and left the run active + stuck on the prior
      // node with nothing in flow_run_events.
      try {
        await sendButtonsAndSuspend(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_buttons_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_buttons_failed");
        return { outcome: "completed" };
      }
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      if (!(await holdConversation(db, run, node.node_key))) return { outcome: "completed" };
      try {
        await sendListAndSuspend(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_list_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_list_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "action") {
      const cfg = node.config as unknown as ActionNodeConfig;
      try {
        const res = await runActionForRun(run, node.node_key, cfg);
        await logEvent(db, run.id, "node_entered", node.node_key, {
          node_type: "action",
          step_type: cfg.step_type,
          detail: res.detail.slice(0, 200),
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "action_failed",
          step_type: cfg.step_type,
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "action_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key ?? null;
      continue;
    }
    if (isDelayNode(node.node_type)) {
      const plan = await planDelay(db, run, node);
      if (!plan.ok) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "delay_invalid", detail: plan.error });
        await endRun(db, run.id, "failed", "delay_invalid");
        return { outcome: "completed" };
      }
      if (plan.skip) {
        currentKey = (node.config as { next_node_key?: string }).next_node_key ?? null;
        continue;
      }
      await parkRun(db, run, node.node_key, plan.at);
      return { outcome: "advanced" };
    }
    if (BOT_STUDIO_AUTO_NODES.has(node.node_type)) {
      const step = await runBotStudioNode(db, run, node);
      if (step.kind === "fail") {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: `${node.node_type}_failed`,
          detail: step.detail,
        });
        await endRun(db, run.id, "failed", `${node.node_type}_failed`);
        return { outcome: "completed" };
      }
      await logEvent(db, run.id, step.sent ? "message_sent" : "node_entered", node.node_key, {
        node_type: node.node_type,
        ...step.log,
      });
      currentKey = step.next;
      continue;
    }
    if (node.node_type === "handoff") {
      await executeHandoff(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(db, run.id, "completed", node.node_key);
      await endRun(db, run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(db, run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

// ============================================================
// Unified-flow helpers (migration 048): background runs, delays and
// Automation actions.
// ============================================================

/**
 * A run must hold the contact's conversation before it asks a question.
 * Runs started by events (and runs resumed after a delay) start in the
 * background; if the contact is already in another bot conversation the
 * run ends instead of interrupting it.
 */
async function holdConversation(db: AdminClient, run: FlowRunRow, nodeKey: string): Promise<boolean> {
  if (run.exclusive !== false) return true;
  const { error } = await db
    .from("flow_runs")
    .update({ exclusive: true })
    .eq("id", run.id)
    .eq("status", "active");
  if (!error) {
    run.exclusive = true;
    return true;
  }
  const busy = (error.message ?? "").includes("duplicate key") || error.code === "23505";
  await logEvent(db, run.id, "error", nodeKey, {
    reason: busy ? "contact_in_another_flow" : "hold_conversation_failed",
    detail: busy ? undefined : error.message,
  });
  await endRun(db, run.id, "failed", busy ? "contact_in_another_flow" : "hold_conversation_failed");
  return false;
}

function actionSource(run: FlowRunRow) {
  return {
    accountId: run.account_id,
    userId: run.user_id,
    sourceId: `flow:${run.flow_id}`,
    sourceName: "Flow",
    contactId: run.contact_id,
    conversationId: run.conversation_id,
    vars: run.vars,
    messageText: typeof run.vars?.message_text === "string" ? (run.vars.message_text as string) : undefined,
    trigger:
      run.vars?.trigger && typeof run.vars.trigger === "object"
        ? (run.vars.trigger as Record<string, unknown>)
        : undefined,
  };
}

async function runActionForRun(run: FlowRunRow, nodeKey: string, cfg: ActionNodeConfig) {
  // Imported lazily: the automations engine imports this module.
  const { runActionStep } = await import("@/lib/automations/engine");
  const res = await runActionStep(actionSource(run), {
    key: `${run.flow_id}:${nodeKey}`,
    type: cfg.step_type as Parameters<typeof runActionStep>[1]["type"],
    config: cfg.step_config ?? {},
  });
  if (JSON.stringify(res.vars) !== JSON.stringify(run.vars ?? {})) {
    run.vars = res.vars;
    await supabaseAdmin().from("flow_runs").update({ vars: res.vars }).eq("id", run.id);
  }
  return res;
}

async function evaluateRuleForRun(
  run: FlowRunRow,
  rule: NonNullable<ConditionNodeConfig["rule"]>,
): Promise<boolean> {
  const { evaluateActionRule } = await import("@/lib/automations/engine");
  return evaluateActionRule(actionSource(run), rule as Parameters<typeof evaluateActionRule>[1]);
}

const DELAY_UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 } as const;

/** Time Delay length in ms: dd/hh/mm/ss, or a converted amount + unit. */
export function delayMs(cfg: TimeDelayNodeConfig): number {
  const n = (v: unknown) => Math.max(0, Number(v) || 0);
  const parts = n(cfg.days) * 86_400_000 + n(cfg.hours) * 3_600_000 + n(cfg.minutes) * 60_000 + n(cfg.seconds) * 1_000;
  if (parts > 0) return parts;
  return n(cfg.amount) * (DELAY_UNIT_MS[cfg.unit ?? "minutes"] ?? DELAY_UNIT_MS.minutes);
}

/** "21/10/2026" or "2026-10-21" + "09:30" → "2026-10-21 09:30". */
export function joinDateTime(date: string, time: string): string {
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(date);
  const iso = dmy ? `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}` : date.slice(0, 10);
  const t = /^(\d{1,2}):(\d{2})$/.exec(time);
  return t ? `${iso} ${t[1].padStart(2, "0")}:${t[2]}` : iso;
}

async function planDelay(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ ok: true; at: Date; skip: boolean } | { ok: false; error: string }> {
  if (node.node_type === "time_delay") {
    const ms = delayMs(node.config as unknown as TimeDelayNodeConfig);
    if (!ms) return { ok: false, error: "delay must be more than 0" };
    return { ok: true, at: new Date(Date.now() + Math.max(1_000, ms)), skip: false };
  }
  const cfg = node.config as unknown as WaitUntilNodeConfig;
  const raw = [cfg.at, cfg.date, cfg.time].filter(Boolean).join(" ");
  const want = needsContact(raw);
  const scope = {
    vars: run.vars,
    trigger: triggerOf(run.vars),
    ...(want.contact && run.contact_id
      ? await loadContactScope(db, run.account_id, run.contact_id, want.custom)
      : {}),
  };
  const fillT = (t?: string) => (t ? interpolateScope(t, scope).trim() : "");
  const plan = planWaitUntil(
    {
      at: cfg.date ? joinDateTime(fillT(cfg.date), fillT(cfg.time)) : fillT(cfg.at),
      timezone: cfg.timezone,
      if_past: cfg.if_past,
      repeat: cfg.repeat,
      offset_minutes:
        (Number(cfg.offset_days) || 0) * 1440 + (Number(cfg.offset_hours) || 0) * 60 + (Number(cfg.offset_minutes) || 0),
    },
    new Date(),
  );
  if (!plan.ok) return { ok: false, error: plan.error };
  if (plan.past) return cfg.if_past === "skip" ? { ok: true, at: new Date(), skip: true } : { ok: true, at: new Date(), skip: false };
  return { ok: true, at: plan.runAt, skip: false };
}

/** Park the run on a delay node. It stops holding the conversation, so
 *  the customer can talk to agents, the AI or other flows meanwhile. */
async function parkRun(db: AdminClient, run: FlowRunRow, nodeKey: string, at: Date): Promise<void> {
  await db
    .from("flow_runs")
    .update({
      current_node_key: nodeKey,
      resume_at: at.toISOString(),
      resume_locked_until: null,
      exclusive: false,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", run.id)
    .eq("status", "active");
  run.current_node_key = nodeKey;
  run.exclusive = false;
  await logEvent(db, run.id, "node_entered", nodeKey, { waiting_until: at.toISOString() });
}

/**
 * Cron: continue runs whose delay is over. Claimed with a lease (SKIP
 * LOCKED), so overlapping workers never resume a run twice. Returns how
 * many runs were resumed. No-op before migration 048.
 */
export async function resumeDueFlowRuns(limit = 50): Promise<number> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("claim_flow_resumes", { p_limit: limit, p_lease_seconds: 120 });
  if (error) {
    if (!isMissingSchemaError(error)) console.error("[flows] claim_flow_resumes failed:", error.message);
    return 0;
  }
  let resumed = 0;
  for (const run of (data ?? []) as FlowRunRow[]) {
    try {
      const nodes = await loadNodesForRun(db, run);
      const node = run.current_node_key ? nodes.get(run.current_node_key) : undefined;
      // Clear the delay first (guarded), so a crash after this point
      // can't resume the same delay twice.
      const { data: cleared } = await db
        .from("flow_runs")
        .update({ resume_at: null, resume_locked_until: null, last_advanced_at: new Date().toISOString() })
        .eq("id", run.id)
        .eq("status", "active")
        .eq("current_node_key", run.current_node_key ?? "")
        .select("id");
      if (!cleared?.length) continue;
      if (!node || !isDelayNode(node.node_type)) {
        await logEvent(db, run.id, "error", run.current_node_key, { reason: "delay_node_missing" });
        await endRun(db, run.id, "failed", "delay_node_missing");
        continue;
      }
      await logEvent(db, run.id, "node_entered", node.node_key, { resumed: true });
      const next = (node.config as { next_node_key?: string }).next_node_key ?? null;
      if (!next) {
        await logEvent(db, run.id, "completed", node.node_key, { reason: "end_of_path" });
        await endRun(db, run.id, "completed", "end_of_path");
      } else {
        await advanceFromNodeKey(db, run, next, nodes);
      }
      resumed += 1;
    } catch (err) {
      console.error("[flows] resume failed:", run.id, err instanceof Error ? err.message : err);
    }
  }
  return resumed;
}

const LOOP_GUARDED = new Set(["conversation_assigned", "conversation_opened", "conversation_closed", "contact_field_changed"]);

/**
 * Start every active flow whose trigger is this event (migration 048).
 * Called by the shared dispatcher in the automations engine, so flows
 * get exactly the events, filters and payloads automations get. Runs
 * start in the background; they take the conversation only when they
 * ask the customer something.
 */
/** Active flows (as published) whose trigger is `triggerType`. */
export async function loadFlowsForTrigger(accountId: string, triggerType: string): Promise<FlowRow[]> {
  const runtime = await loadRuntimeFlows(supabaseAdmin(), accountId);
  return runtime.filter((r) => r.flow.trigger_type === triggerType && r.flow.entry_node_id).map((r) => r.flow);
}

export async function startFlowsForEvent(input: {
  accountId: string;
  triggerType: string;
  contactId: string | null;
  context: {
    conversation_id?: string;
    message_text?: string;
    vars?: Record<string, unknown>;
    trigger?: Record<string, unknown>;
  };
  flowId?: string;
}): Promise<number> {
  if (!input.contactId || !isEventTrigger(input.triggerType)) return 0;
  const db = supabaseAdmin();
  const runtime = (await loadRuntimeFlows(db, input.accountId)).filter(
    (r) =>
      r.flow.trigger_type === input.triggerType &&
      r.flow.entry_node_id &&
      (!input.flowId || r.flow.id === input.flowId),
  );
  if (!runtime.length) return 0;

  const { triggerMatches } = await import("@/lib/automations/engine");
  let conversationId = input.context.conversation_id ?? null;
  if (!conversationId) {
    const { data } = await db
      .from("conversations")
      .select("id")
      .eq("account_id", input.accountId)
      .eq("contact_id", input.contactId)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1);
    conversationId = (data?.[0] as { id?: string } | undefined)?.id ?? null;
  }

  let started = 0;
  for (const rf of runtime) {
    const asRule = { trigger_type: rf.flow.trigger_type, trigger_config: rf.flow.trigger_config };
    if (!triggerMatches(asRule as Parameters<typeof triggerMatches>[0], input.context as Parameters<typeof triggerMatches>[1])) continue;
    if (LOOP_GUARDED.has(input.triggerType)) {
      const { count } = await db
        .from("flow_runs")
        .select("id", { count: "exact", head: true })
        .eq("flow_id", rf.flow.id)
        .eq("contact_id", input.contactId)
        .gte("started_at", new Date(Date.now() - 10 * 60_000).toISOString());
      if ((count ?? 0) >= 5) {
        console.warn("[flows] loop guard: skipping", rf.flow.id, input.triggerType);
        continue;
      }
    }
    // "Initiate a fresh start of the user journey": end the bot
    // conversation the contact is in, then start this flow.
    if ((rf.flow.trigger_config as { restart_policy?: string }).restart_policy === "restart") {
      const active = await loadActiveRunForContact(db, input.accountId, input.contactId);
      if (active) {
        await logEvent(db, active.id, "completed", active.current_node_key, {
          reason: "restarted_by_trigger",
          restarted_flow_id: rf.flow.id,
        });
        await endRun(db, active.id, "completed", "restarted_by_trigger");
      }
    }
    const nodes = rf.version ? nodesFromVersion(rf.version) : await loadAllNodes(db, rf.flow.id);
    const res = await startNewRun(
      db,
      rf.flow,
      {
        accountId: input.accountId,
        userId: rf.flow.user_id,
        contactId: input.contactId,
        conversationId: conversationId as string,
        message: {
          kind: "text",
          text: input.context.message_text ?? "",
          meta_message_id: `event:${input.triggerType}:${Date.now()}`,
        },
      },
      nodes,
      rf.version?.version ?? null,
      {
        exclusive: false,
        vars: {
          ...(input.context.vars ?? {}),
          ...(input.context.message_text ? { message_text: input.context.message_text } : {}),
          ...(input.context.trigger ? { trigger: input.context.trigger } : {}),
        },
      },
    );
    if (res.flow_run_id) started += 1;
  }
  return started;
}

// ============================================================
// Bot Studio node executor. Each node performs one action through the
// shared handlers (lib/bot) and picks the next node key. A failure
// returns kind 'fail' and the caller ends the run as failed — the same
// contract as the original send nodes.
// ============================================================

type BotStudioStep =
  | { kind: "next"; next: string; sent?: boolean; log: Record<string, unknown> }
  | { kind: "fail"; detail: string };

async function runBotStudioNode(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<BotStudioStep> {
  const fail = (detail: string): BotStudioStep => ({ kind: "fail", detail });
  // Variable scope: run vars + (lazily) the contact for {{contact.*}}.
  const texts = JSON.stringify(node.config);
  const want = needsContact(texts);
  const scope = {
    vars: run.vars,
    trigger: triggerOf(run.vars),
    ...(want.contact && run.contact_id
      ? await loadContactScope(db, run.account_id, run.contact_id, want.custom)
      : {}),
  };
  const fill = (t: string | undefined) => (t ? interpolateScope(t, scope) : "");
  const base = {
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
  };
  try {
    switch (node.node_type) {
      case "send_location": {
        const cfg = node.config as unknown as SendLocationNodeConfig;
        const { whatsapp_message_id } = await engineSendLocation({
          ...base,
          latitude: Number(fill(String(cfg.latitude ?? ""))),
          longitude: Number(fill(String(cfg.longitude ?? ""))),
          name: fill(cfg.name) || undefined,
          address: fill(cfg.address) || undefined,
        });
        return { kind: "next", next: cfg.next_node_key, sent: true, log: { whatsapp_message_id } };
      }
      case "send_template": {
        const cfg = node.config as unknown as SendTemplateNodeConfig;
        if (!cfg.template_name) return fail("no template selected");
        const { whatsapp_message_id } = await engineSendTemplate({
          ...base,
          templateName: cfg.template_name,
          language: cfg.language,
          params: (cfg.params ?? []).map((p) => fill(p)),
          headerMediaUrl: fill(cfg.header_media_url) || undefined,
        });
        return { kind: "next", next: cfg.next_node_key, sent: true, log: { whatsapp_message_id, template: cfg.template_name } };
      }
      case "assign_agent": {
        const cfg = node.config as unknown as AssignAgentNodeConfig;
        const r = await assignConversation(db, {
          accountId: run.account_id,
          conversationId: run.conversation_id,
          contactId: run.contact_id,
          mode: cfg.mode ?? "round_robin",
          agentId: cfg.agent_id,
          pool: cfg.pool,
          reassign: cfg.reassign === true,
          poolKey: `flow:${run.flow_id}:${node.node_key}`,
        });
        // Assignment never stops the flow (that is what Handoff is for).
        return { kind: "next", next: cfg.next_node_key, log: { assignment: r.status, agent_id: "agentId" in r ? r.agentId : null } };
      }
      case "set_field": {
        const cfg = node.config as unknown as SetFieldNodeConfig;
        const value = cfg.mode === "clear" ? null : fill(cfg.value);
        const r = await setContactField(db, {
          accountId: run.account_id,
          contactId: run.contact_id!,
          field: cfg.field,
          value,
        });
        if (r === "not_writable") return fail(`field ${cfg.field} is not writable`);
        return { kind: "next", next: cfg.next_node_key, log: { field: cfg.field, result: r } };
      }
      case "working_hours": {
        const cfg = node.config as unknown as WorkingHoursNodeConfig;
        const state = workingHoursAt(new Date(), await loadBusinessHours(db, run.account_id));
        const next =
          state === "open" ? cfg.open_next : state === "holiday" && cfg.holiday_next ? cfg.holiday_next : cfg.closed_next;
        return { kind: "next", next, log: { working_hours: state, advancing_to: next } };
      }
      case "opt_out": {
        const cfg = node.config as unknown as { next_node_key: string };
        const r = await optOutContact(db, {
          accountId: run.account_id,
          contactId: run.contact_id!,
          source: `Flow opt-out node (${node.node_key})`,
        });
        return { kind: "next", next: cfg.next_node_key, log: { opt_out: r } };
      }
      case "format_value": {
        const cfg = node.config as unknown as FormatValueNodeConfig;
        const input = fill(cfg.input);
        const res =
          cfg.kind === "phone"
            ? formatPhone(input, { defaultCountryCode: cfg.default_country_code, output: cfg.phone_output })
            : formatDate(input, {
                inputFormat: cfg.input_format,
                inputTimezone: cfg.input_timezone,
                outputFormat: cfg.output_format || "DD MMM YYYY",
                outputTimezone: cfg.output_timezone,
              });
        if (!res.ok) {
          if (cfg.error_next) return { kind: "next", next: cfg.error_next, log: { format_error: res.error } };
          return fail(res.error);
        }
        const vars = { ...run.vars, [cfg.output_var]: res.value };
        await db.from("flow_runs").update({ vars }).eq("id", run.id);
        run.vars = vars;
        return { kind: "next", next: cfg.next_node_key, log: { output_var: cfg.output_var } };
      }
      case "ai_reply": {
        const cfg = node.config as unknown as AiReplyNodeConfig;
        if (!run.conversation_id) return fail("no conversation");
        const r = await runAiStep(db, {
          accountId: run.account_id,
          conversationId: run.conversation_id,
          instruction: cfg.instruction,
        });
        if (!r.ok) {
          if (cfg.handoff_next) return { kind: "next", next: cfg.handoff_next, log: { ai: r.reason } };
          return fail(`AI step: ${r.reason}${r.detail ? ` (${r.detail})` : ""}`);
        }
        if (r.handoff) {
          return { kind: "next", next: cfg.handoff_next || cfg.next_node_key, log: { ai: "handoff_requested" } };
        }
        if (cfg.output_var) {
          const vars = { ...run.vars, [cfg.output_var]: r.text };
          await db.from("flow_runs").update({ vars }).eq("id", run.id);
          run.vars = vars;
        }
        let sentId: string | null = null;
        if (cfg.send) {
          const { whatsapp_message_id } = await engineSendText({ ...base, text: r.text, aiGenerated: true });
          sentId = whatsapp_message_id;
        }
        return { kind: "next", next: cfg.next_node_key, sent: Boolean(sentId), log: { ai: "answered", whatsapp_message_id: sentId } };
      }
      case "call_api": {
        // Saved API definition (migration 049), run server-side through
        // the SSRF-guarded runner. Failure output when connected; else the
        // run fails with the reason (visible in Bot logs).
        const cfg = node.config as unknown as CallApiNodeConfig;
        if (!cfg.api_id) return fail("no API selected");
        const { data: def, error: defErr } = await db
          .from("api_definitions")
          .select("id, name, method, url, headers, body, response_map")
          .eq("id", cfg.api_id)
          .eq("account_id", run.account_id)
          .maybeSingle();
        if (defErr || !def) return fail(defErr ? `API lookup failed: ${defErr.message}` : "the selected API no longer exists");
        const d = def as ApiDefinition;
        const strings = JSON.stringify([d.url, d.headers, d.body]);
        const wantApi = needsContact(strings);
        const apiScope = {
          vars: run.vars,
          trigger: (run.vars?.trigger as Record<string, unknown> | undefined) ?? undefined,
          ...(wantApi.contact && run.contact_id
            ? await loadContactScope(db, run.account_id, run.contact_id, wantApi.custom)
            : {}),
        };
        const r = await performApiCall(d, (t) => interpolateScope(t, apiScope));
        const updates: Record<string, unknown> = { ...r.mapped };
        if (cfg.response_var) {
          updates[cfg.response_var] = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? null).slice(0, 16_000);
        }
        updates.api_status = r.status;
        const vars = { ...run.vars, ...updates };
        await db.from("flow_runs").update({ vars }).eq("id", run.id);
        run.vars = vars;
        const log = { api: d.name, status: r.status, ok: r.ok, error: r.error ?? null };
        if (r.ok) return { kind: "next", next: cfg.next_node_key ?? "", log };
        if (cfg.failure_next) return { kind: "next", next: cfg.failure_next, log };
        return fail(`Call Api "${d.name}": ${r.error ?? "failed"}`);
      }
      case "google_sheets": {
        // Add Row (migration 051): values are matched to the tab's header
        // row by name and written RAW. Failure output when connected.
        const cfg = node.config as unknown as GoogleSheetsNodeConfig;
        const failed = (detail: string): BotStudioStep =>
          cfg.failure_next ? { kind: "next", next: cfg.failure_next, log: { sheets_error: detail } } : fail(`Google Sheets: ${detail}`);
        if (!cfg.spreadsheet_id || !cfg.sheet_name) return failed("no spreadsheet selected");
        const { getAccessToken } = await import("@/lib/google/connection");
        const sheets = await import("@/lib/google/sheets");
        try {
          const token = await getAccessToken(db, run.account_id);
          const headers = await sheets.getHeaders(token, cfg.spreadsheet_id, cfg.sheet_name);
          if (!headers.some((h) => h.trim())) return failed(`tab "${cfg.sheet_name}" has no header row`);
          const { row, unknown } = sheets.buildRow(
            headers,
            (cfg.columns ?? []).map((c) => ({ column: c.column, value: fill(c.value) })),
          );
          if (unknown.length) return failed(`column${unknown.length > 1 ? "s" : ""} not in the header row: ${unknown.join(", ")}`);
          if (!row.length) return failed("every mapped value is empty");
          const range = await sheets.appendRow(token, cfg.spreadsheet_id, cfg.sheet_name, row);
          const rowNumber = Number(range?.match(/(\d+)(?::[A-Z]+\d+)?$/)?.[1]) || null;
          if (rowNumber) {
            const vars = { ...run.vars, sheet_row: rowNumber };
            await db.from("flow_runs").update({ vars }).eq("id", run.id);
            run.vars = vars;
          }
          return { kind: "next", next: cfg.next_node_key ?? "", log: { sheet: cfg.sheet_name, range } };
        } catch (err) {
          return failed(err instanceof Error ? err.message : String(err));
        }
      }
      default:
        return fail(`unknown node type ${node.node_type}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "active");
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  try {
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId,
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      // Restart policy (opt-in per keyword flow): a keyword that belongs
      // to a flow set to 'restart' ends the current run and starts that
      // flow fresh. Default 'continue' keeps the original behaviour.
      const restart = await findRestartFlow(db, input.accountId, input.message);
      if (restart) {
        await logEvent(db, activeRun.id, "completed", activeRun.current_node_key, {
          reason: "restarted_by_keyword",
          restarted_flow_id: restart.flow.id,
        });
        await endRun(db, activeRun.id, "completed", "restarted_by_keyword");
        const nodes = restart.version ? nodesFromVersion(restart.version) : await loadAllNodes(db, restart.flow.id);
        return startNewRun(db, restart.flow, input, nodes, restart.version?.version ?? null);
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. Pinned to the run's published version when it has one.
      const nodes = await loadNodesForRun(db, activeRun);
      return handleReplyForActiveRun(db, activeRun, input.message, nodes);
    }

    // No active run → look for a flow whose entry trigger matches.
    const found = await findEntryFlow(
      db,
      input.accountId,
      input.message,
      input.isFirstInboundMessage,
    );
    if (!found || !found.flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = found.version ? nodesFromVersion(found.version) : await loadAllNodes(db, found.flow.id);
    return startNewRun(db, found.flow, input, nodes, found.version?.version ?? null);
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

async function findRestartFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
): Promise<RuntimeFlow | null> {
  if (message.kind !== "text") return null; // taps answer the open prompt
  const runtime = await loadRuntimeFlows(db, accountId);
  for (const rf of runtime) {
    if (rf.flow.trigger_type !== "keyword") continue;
    const cfg = rf.flow.trigger_config as KeywordTriggerConfig;
    if (cfg.restart_policy !== "restart") continue;
    if (matchesKeywordTrigger(message.text, cfg)) return rf;
  }
  return null;
}

/**
 * Start a flow for a contact without an inbound message — the manual
 * "Start flow" action in the inbox and the Automation → Flow bridge.
 * Refuses when the contact is already in a flow (one active run per
 * contact) unless `replaceActive` is set. Uses the published version.
 *
 * The flow's first message must be sendable at that moment: outside the
 * 24-hour window only an approved template (send_template) reaches the
 * customer, which the builder warns about.
 */
export async function startFlowForContact(input: {
  accountId: string;
  flowId: string;
  contactId: string;
  conversationId: string;
  userId: string;
  source: string;
  replaceActive?: boolean;
}): Promise<{ ok: true; flow_run_id: string } | { ok: false; reason: string }> {
  const db = supabaseAdmin();
  const runtime = (await loadRuntimeFlows(db, input.accountId)).find((r) => r.flow.id === input.flowId);
  if (!runtime) return { ok: false, reason: "flow_not_active" };
  if (!runtime.flow.entry_node_id) return { ok: false, reason: "flow_has_no_entry" };
  const { data: owned } = await db
    .from("conversations")
    .select("id")
    .eq("id", input.conversationId)
    .eq("account_id", input.accountId)
    .eq("contact_id", input.contactId)
    .maybeSingle();
  if (!owned) return { ok: false, reason: "conversation_not_found" };

  const active = await loadActiveRunForContact(db, input.accountId, input.contactId);
  if (active) {
    if (!input.replaceActive) return { ok: false, reason: "contact_in_another_flow" };
    await logEvent(db, active.id, "completed", active.current_node_key, { reason: "replaced", by: input.source });
    await endRun(db, active.id, "completed", "replaced_by_start");
  }
  const nodes = runtime.version ? nodesFromVersion(runtime.version) : await loadAllNodes(db, input.flowId);
  const res = await startNewRun(
    db,
    runtime.flow,
    {
      accountId: input.accountId,
      userId: input.userId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      message: { kind: "text", text: "", meta_message_id: `start:${input.source}:${Date.now()}` },
    },
    nodes,
    runtime.version?.version ?? null,
  );
  return res.flow_run_id ? { ok: true, flow_run_id: res.flow_run_id } : { ok: false, reason: res.outcome ?? "not_started" };
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(db, run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
  });

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(db, run.id, "failed", "active_run_missing_current_node");
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(db, run.id, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // Two ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Text reply on a collect_input node — capture into vars.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    const valid = !cfg.enforce_validation || answerIsValid(captured, cfg);
    if (!valid && cfg.invalid_text?.trim()) {
      try {
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.invalid_text, run.vars),
        });
      } catch {
        // The reprompt below still runs; a failed hint is not fatal.
      }
    }
    if (valid && captured.length > 0 && cfg.var_key) {
      // Persist captured value + reset reprompt count atomically.
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      const { error: capErr } = await db
        .from("flow_runs")
        .update({
          vars: newVars,
          reprompt_count: 0,
        })
        .eq("id", run.id);
      if (!capErr) {
        // Mirror the UPDATE in-memory so downstream interpolation in
        // the advance loop sees the captured var without us having to
        // re-SELECT the whole row.
        run.vars = newVars;
        run.reprompt_count = 0;
        await logEvent(db, run.id, "node_entered", currentNode.node_key, {
          captured_key: cfg.var_key,
          captured_length: captured.length,
        });
        matched = cfg.next_node_key;
      }
    }
  }

  // Send Message with "On response": any reply (typed text, or the title
  // of a tapped option) continues the flow; stored when a variable is set.
  if (!matched && currentNode.node_type === "send_message") {
    const cfg = currentNode.config as unknown as SendMessageNodeConfig;
    if (cfg.wait_reply) {
      const answer = message.kind === "text" ? message.text.trim() : message.reply_title;
      if (cfg.reply_var) {
        const newVars = { ...run.vars, [cfg.reply_var]: answer };
        await db.from("flow_runs").update({ vars: newVars }).eq("id", run.id);
        run.vars = newVars;
      }
      await logEvent(db, run.id, "node_entered", currentNode.node_key, {
        captured_key: cfg.reply_var ?? null,
        captured_length: answer.length,
      });
      if (!cfg.next_node_key) {
        await logEvent(db, run.id, "completed", currentNode.node_key, { reason: "end_of_path" });
        await endRun(db, run.id, "completed", "end_of_path");
        return { consumed: true, flow_run_id: run.id, outcome: "completed" };
      }
      matched = cfg.next_node_key;
    }
  }

  // Buttons / list "Any other reply" output: a reply that matches no
  // option goes there instead of the reprompt fallback.
  const otherNext = (currentNode.config as { other_next?: string }).other_next;
  if (
    !matched &&
    otherNext &&
    (currentNode.node_type === "send_buttons" || currentNode.node_type === "send_list")
  ) {
    const answer = message.kind === "text" ? message.text.trim() : message.reply_title;
    const newVars = { ...run.vars, last_reply: answer };
    await db.from("flow_runs").update({ vars: newVars }).eq("id", run.id);
    run.vars = newVars;
    await logEvent(db, run.id, "node_entered", currentNode.node_key, { branch: "other" });
    matched = otherNext;
  }

  if (matched) {
    // Reset reprompt count on a successful match. Skip the write when
    // already 0 — the collect_input capture branch above already
    // zeroed it, and interactive-reply matches against a fresh run
    // (post-prior-reset) are also already 0. The previous re-read of
    // the whole row was needed only because we weren't mirroring the
    // capture UPDATE into the in-memory `run`; now that we do, the
    // local copy is the source of truth.
    if (run.reprompt_count !== 0) {
      const { error } = await db
        .from("flow_runs")
        .update({ reprompt_count: 0 })
        .eq("id", run.id);
      if (!error) run.reprompt_count = 0;
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const pinned = run.flow_version ? await loadVersion(db, run.flow_id, run.flow_version) : null;
  const policy = resolveFallbackPolicy(
    pinned?.fallback_policy ?? (await loadFlow(db, run.flow_id))?.fallback_policy,
  );
  const newReprompts = run.reprompt_count + 1;
  await db
    .from("flow_runs")
    .update({ reprompt_count: newReprompts })
    .eq("id", run.id);

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  if (action.type === "reprompt") {
    // Re-send the same prompt. Same node, no current_node_key change.
    // The interactive helpers interpolate run.vars themselves, so a
    // reprompt renders the same text the original prompt did. A send
    // failure here is logged but does not end the run — the customer
    // still has the original prompt on screen and can retry.
    try {
      if (currentNode.node_type === "send_buttons") {
        await sendButtonsAndSuspend(db, run, currentNode);
      } else if (currentNode.node_type === "send_list") {
        await sendListAndSuspend(db, run, currentNode);
      } else if (currentNode.node_type === "collect_input") {
        // Customer typed something we couldn't accept (empty after trim,
        // or var_key missing — rare). Re-send the prompt so they try again.
        const cfg = currentNode.config as unknown as CollectInputNodeConfig;
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      }
    } catch (err) {
      await logEvent(db, run.id, "error", currentNode.node_key, {
        reason: "reprompt_send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", run.conversation_id);
    }
    await logEvent(db, run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
    });
    await endRun(db, run.id, "handed_off", "fallback_exhausted");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  // action.type === 'end'
  await endRun(db, run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
  flowVersion: number | null = null,
  opts: { exclusive?: boolean; vars?: Record<string, unknown> } = {},
): Promise<DispatchInboundResult> {
  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
      ...(flowVersion ? { flow_version: flowVersion } : {}),
      // Only set for event runs: older databases have no column, and
      // conversation runs rely on the default (true).
      ...(opts.exclusive === false ? { exclusive: false } : {}),
      ...(opts.vars && Object.keys(opts.vars).length ? { vars: opts.vars } : {}),
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
    flow_version: flowVersion,
  });
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error("[flows] execution_count rpc error:", incErr.message);
  }

  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
