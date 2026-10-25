/**
 * Type definitions for the Flows runtime.
 *
 * These mirror the Supabase schema added in migration 010 (`flows`,
 * `flow_nodes`, `flow_runs`, `flow_run_events`) plus the discriminated
 * unions the engine uses to typecheck node configs.
 *
 * Schema invariants enforced here that the DB CHECK constraints don't:
 *   - Each node_type maps to one config shape — adding a new node_type
 *     requires adding the matching config interface AND extending
 *     `FlowNodeConfig` so the engine's exhaustiveness checks light up.
 *   - Edges live INSIDE the config (each button row / list row carries
 *     `next_node_key`). The DB schema doesn't model this — the
 *     validator (PR #3) catches missing or orphan edges at save time.
 *
 * `next_node_key` is the stable string id stored in `flow_nodes.node_key`,
 * not a UUID, so flows can be cloned / templated without rewriting
 * references in JSONB.
 */

// ============================================================
// Node configs (discriminated union by node_type)
// ============================================================

export interface StartNodeConfig {
  /** Stable node_key of the first real node to advance to. */
  next_node_key: string;
}

export interface SendMessageNodeConfig {
  /** Plain text sent to the customer; can interpolate {{vars.X}}. */
  text: string;
  /** Auto-advance target after the message lands at Meta. */
  next_node_key: string;
  /** Bot Builder: optional attachment (upload or URL); `text` becomes the caption. */
  media_url?: string;
  media_type?: "image" | "video" | "document" | "audio";
  filename?: string;
  /** "On response": wait for the customer's reply before continuing. */
  wait_reply?: boolean;
  /** Variable that stores the reply (optional). */
  reply_var?: string;
}

export interface SendButtonsNodeConfig {
  text: string;
  /** Optional header / footer lines around the buttons. */
  header_text?: string;
  footer_text?: string;
  /** Bot Builder "Header > Media": image / video / document header. */
  header_media_url?: string;
  header_media_type?: "image" | "video" | "document";
  /** "Any other reply" output: replies that match no button. */
  other_next?: string;
  /** 1-3 buttons; Meta cap enforced in meta-api validation. */
  buttons: Array<{
    /** Stable id sent back by Meta when this button is tapped. */
    reply_id: string;
    /** Visible label (≤ 20 chars per Meta). */
    title: string;
    /** node_key the runner advances to when this button is tapped. */
    next_node_key: string;
  }>;
}

export interface SendListNodeConfig {
  text: string;
  /** Label of the tap-to-expand button on the message bubble. */
  button_label: string;
  /** "Any other reply" output: replies that match no row. */
  other_next?: string;
  header_text?: string;
  footer_text?: string;
  /** 1-10 rows TOTAL across sections; cap enforced in meta-api. */
  sections: Array<{
    title?: string;
    rows: Array<{
      reply_id: string;
      title: string;
      description?: string;
      next_node_key: string;
    }>;
  }>;
}

/**
 * Sends a single image / video / document via WhatsApp, then
 * auto-advances. The media file is uploaded to the `flow-media`
 * Supabase Storage bucket by the builder; `media_url` is the public
 * URL Meta fetches at send time.
 *
 * Why one node with a `media_type` discriminator (rather than three
 * separate node types): Meta's send-side payload differs only in the
 * top-level key (`image` / `video` / `document`) and the
 * filename-on-document quirk. Modeling three node types would triple
 * the builder forms, engine cases, and add-menu entries for no
 * meaningful behavioural difference.
 */
export interface SendMediaNodeConfig {
  media_type: "image" | "video" | "document";
  /** Public URL Meta will fetch. Uploaded via the builder's file picker. */
  media_url: string;
  /** Optional caption shown under the media (Meta caps at 1024 chars). */
  caption?: string;
  /**
   * Filename shown in the recipient's chat. Documents only — Meta
   * ignores it for image/video. Defaults to the file's original name
   * at upload time; the user can edit it.
   */
  filename?: string;
  /** Auto-advance target after the send lands at Meta. */
  next_node_key: string;
}

export interface HandoffNodeConfig {
  /** Optional internal note written to flow_run_events.payload.note. */
  note?: string;
  /**
   * Optional agent user_id to assign on the conversation when this
   * node fires. Leave unset to flip the status without assignment.
   */
  assign_to?: string;
}

/**
 * Captures the customer's next free-text reply into
 * `flow_runs.vars[var_key]`, then advances.
 *
 * v1.5 ships without runtime validation (`validation` is accepted on
 * the config for forward compat but ignored by the runner); the
 * builder still surfaces the field so users can author flows that
 * v2 will start enforcing.
 */
export interface CollectInputNodeConfig {
  /** Prompt text sent to the customer before they reply. */
  prompt_text: string;
  /**
   * Key under which to store the captured text in
   * `flow_runs.vars`. Stable identifier — used by downstream
   * `condition` nodes and `handoff` notes via interpolation.
   */
  var_key: string;
  /**
   * Reserved for v2. Accepted on the config but ignored by the v1.5
   * runner — captures any non-empty text.
   */
  validation?: "any" | "email" | "phone" | "number" | "regex";
  /** Used only when `validation === 'regex'`. */
  regex?: string;
  /**
   * Opt-in (Bot Studio): when true the runner enforces `validation` — an
   * answer that fails is treated like an unknown reply (fallback policy:
   * reprompt / handoff / end). Absent on older flows, which keep
   * accepting any non-empty text.
   */
  enforce_validation?: boolean;
  /** Message sent before the reprompt when validation fails. */
  invalid_text?: string;
  /** Node to advance to after capture. */
  next_node_key: string;
}

export type ConditionOperator =
  | "equals"
  | "contains"
  | "present"
  | "absent";

export type ConditionSubject = "var" | "tag" | "contact_field";

/**
 * Routes the run based on a predicate over the contact's tags,
 * profile fields, or stored vars. Always auto-advances — no Meta
 * call, no customer-side input.
 */
export interface ConditionNodeConfig {
  subject: ConditionSubject;
  /**
   * For `var`: the key in flow_runs.vars.
   * For `tag`: the tag UUID (matched against contact_tags).
   * For `contact_field`: one of 'name' | 'email' | 'phone' | 'company'.
   */
  subject_key: string;
  operator: ConditionOperator;
  /** Compared against `subject` for `equals`/`contains`. Ignored for `present`/`absent`. */
  value?: string;
  /**
   * Migration 048: an Automation-style rule (tag present, field equals,
   * message contains, time of day, working hours). When set it replaces
   * subject/operator. Used by converted automations.
   */
  rule?: { subject: string; operand?: string; value?: string };
  /** Node to advance to when the predicate evaluates true. */
  true_next: string;
  /** Node to advance to when it evaluates false. */
  false_next: string;
}

export interface SetTagNodeConfig {
  mode: "add" | "remove";
  /** Tag UUID. The builder picks from the user's existing tags. */
  tag_id: string;
  /** Bot Builder: several tags (or broadcast lists) at once. */
  tag_ids?: string[];
  next_node_key: string;
}

// Terminal nodes carry no config — they just stop the run.
export type EndNodeConfig = Record<string, never>;

// ── Bot Studio nodes (migration 047). All auto-advance. ──────────────

/** A WhatsApp location pin. Values may use {{vars.x}} tokens. */
export interface SendLocationNodeConfig {
  latitude: string;
  longitude: string;
  name?: string;
  address?: string;
  next_node_key: string;
}

/** An approved template (works outside the 24-hour window). */
export interface SendTemplateNodeConfig {
  template_name: string;
  language?: string;
  /** Positional body params {{1}}, {{2}} … — each may use variables. */
  params?: string[];
  /** Image/video/document header link for media-header templates. */
  header_media_url?: string;
  next_node_key: string;
}

/**
 * Assigns the conversation WITHOUT ending the run (unlike `handoff`).
 * `reassign` defaults to false: an already-assigned chat keeps its agent.
 */
export interface AssignAgentNodeConfig {
  mode: "specific" | "round_robin" | "random" | "last_agent";
  agent_id?: string;
  /** Candidate user ids; empty = every owner/admin/agent. */
  pool?: string[];
  reassign?: boolean;
  next_node_key: string;
}

/** Set (or clear) a contact attribute: name/email/company/custom:<id>. */
export interface SetFieldNodeConfig {
  field: string;
  value?: string;
  mode?: "set" | "clear";
  next_node_key: string;
}

/** Branches on the account's business hours (Settings → Business hours). */
export interface WorkingHoursNodeConfig {
  open_next: string;
  closed_next: string;
  /** Optional; holidays follow `closed_next` when unset. */
  holiday_next?: string;
}

/** Opts the contact out of MARKETING messages (audited, not a block). */
export interface OptOutNodeConfig {
  next_node_key: string;
}

/** Format a date or phone number into a variable. */
export interface FormatValueNodeConfig {
  kind: "date" | "phone";
  /** Source text, usually a token like {{vars.visit_date}}. */
  input: string;
  output_var: string;
  input_format?: "auto" | "iso" | "dmy" | "mdy" | "ymd" | "epoch_ms" | "epoch_s";
  input_timezone?: string;
  output_format?: string;
  output_timezone?: string;
  default_country_code?: string;
  phone_output?: "e164" | "digits" | "national";
  next_node_key: string;
  /** Taken when the input can't be formatted; otherwise the run fails. */
  error_next?: string;
}

/**
 * Explicit, scoped AI step: generates one answer from the account's AI
 * configuration + knowledge base. Independent of global auto-reply (it
 * runs only where the flow author placed it) and never runs for the
 * same inbound twice, because the flow owns that inbound.
 */
export interface AiReplyNodeConfig {
  /** Store the answer in vars[output_var] (optional). */
  output_var?: string;
  /** Send the answer to the customer as a text message. */
  send: boolean;
  /** Extra instruction appended to the account's system prompt. */
  instruction?: string;
  next_node_key: string;
  /** Taken when the model asks for a human; otherwise next_node_key. */
  handoff_next?: string;
}

// ── Unified Flow nodes (migration 048) ───────────────────────────────

/** Pause the run, then continue. The contact is free meanwhile. */
export interface TimeDelayNodeConfig {
  /** Bot Builder dd / hh / mm / ss. */
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
  /** Converted automations (legacy shape): amount + unit. */
  amount?: number;
  unit?: "minutes" | "hours" | "days";
  next_node_key?: string;
}

/** Pause until a date/time (literal or {{token}}), then continue. */
export interface WaitUntilNodeConfig {
  /** Converted automations: one date-time string (or token). */
  at?: string;
  /** Bot Builder: scheduled date (DD/MM/YYYY, YYYY-MM-DD or a token)… */
  date?: string;
  /** …and 24-hour time (HH:mm, or a token). */
  time?: string;
  /** "Trigger before scheduled time". */
  offset_days?: number;
  offset_hours?: number;
  offset_minutes?: number;
  /** Repeat trigger: weekly = next occurrence of that weekday + time. */
  repeat?: "none" | "weekly";
  timezone?: string;
  /** What to do when the time has already passed. Default 'run_now'. */
  if_past?: "run_now" | "skip";
  next_node_key?: string;
}

/** "Call Api": run a saved API definition (migration 049). */
export interface CallApiNodeConfig {
  api_id: string;
  /** Store the whole response (JSON text) in this variable. */
  response_var?: string;
  /** Success output (2xx). */
  next_node_key?: string;
  /** Failure output (network error, blocked URL, non-2xx). */
  failure_next?: string;
}

/** Google Sheets "Add Row" (migration 051). */
export interface GoogleSheetsNodeConfig {
  spreadsheet_id: string;
  spreadsheet_title?: string;
  sheet_name: string;
  /** Header row as last loaded in the builder (display only). */
  headers?: string[];
  /** Value per column, matched to the header row by name at run time. */
  columns: { column: string; value: string }[];
  next_node_key?: string;
  failure_next?: string;
}

/**
 * Runs one Automation step (same executor as Automations), e.g.
 * close_conversation, send_webhook, create_deal, start_flow, or a
 * converted send_buttons that doesn't wait for a reply.
 */
export interface ActionNodeConfig {
  step_type: string;
  step_config: Record<string, unknown>;
  next_node_key?: string;
}

/**
 * Total union — every concrete node_type the v1 engine understands.
 * Add new node types here and the engine's switch will flag missing
 * cases via TypeScript's exhaustiveness check.
 *
 * v1.5+ additions (collect_input, condition, set_tag, http_fetch) will
 * extend this union — out-of-scope for the v1 engine PR.
 */
export type FlowNodeConfig =
  | { node_type: "start"; config: StartNodeConfig }
  | { node_type: "send_message"; config: SendMessageNodeConfig }
  | { node_type: "send_buttons"; config: SendButtonsNodeConfig }
  | { node_type: "send_list"; config: SendListNodeConfig }
  | { node_type: "send_media"; config: SendMediaNodeConfig }
  | { node_type: "collect_input"; config: CollectInputNodeConfig }
  | { node_type: "condition"; config: ConditionNodeConfig }
  | { node_type: "set_tag"; config: SetTagNodeConfig }
  | { node_type: "handoff"; config: HandoffNodeConfig }
  | { node_type: "end"; config: EndNodeConfig }
  | { node_type: "send_location"; config: SendLocationNodeConfig }
  | { node_type: "send_template"; config: SendTemplateNodeConfig }
  | { node_type: "assign_agent"; config: AssignAgentNodeConfig }
  | { node_type: "set_field"; config: SetFieldNodeConfig }
  | { node_type: "working_hours"; config: WorkingHoursNodeConfig }
  | { node_type: "opt_out"; config: OptOutNodeConfig }
  | { node_type: "format_value"; config: FormatValueNodeConfig }
  | { node_type: "ai_reply"; config: AiReplyNodeConfig }
  | { node_type: "time_delay"; config: TimeDelayNodeConfig }
  | { node_type: "wait_until"; config: WaitUntilNodeConfig }
  | { node_type: "action"; config: ActionNodeConfig }
  | { node_type: "call_api"; config: CallApiNodeConfig }
  | { node_type: "google_sheets"; config: GoogleSheetsNodeConfig };

export type FlowNodeType = FlowNodeConfig["node_type"];

// ============================================================
// Triggers (matches `flows.trigger_type` + `trigger_config`)
// ============================================================

export interface KeywordTriggerConfig {
  /** One or more keywords. Match is case-insensitive by default. */
  keywords: string[];
  /** 'word' = whole-word match (same rules as automations). */
  match_type?: "exact" | "contains" | "word";
  case_sensitive?: boolean;
  /**
   * What a matching keyword does while the customer is already inside a
   * flow. 'continue' (default, the original behaviour): the active run
   * keeps the message. 'restart': end the active run (recorded as
   * restarted) and start this flow fresh.
   */
  restart_policy?: "continue" | "restart";
}

// No knobs in v1 — the trigger has a single semantic. Kept as a type
// alias (not an empty interface) for forward compat without tripping
// the no-empty-object-type lint rule.
export type FirstInboundTriggerConfig = Record<string, never>;

export type FlowTriggerConfig =
  | { trigger_type: "keyword"; config: KeywordTriggerConfig }
  | { trigger_type: "first_inbound_message"; config: FirstInboundTriggerConfig }
  | { trigger_type: "manual"; config: Record<string, never> };

/** Triggers the flow runner matches itself on inbound messages. */
export const CONVERSATION_TRIGGERS = ["keyword", "first_inbound_message", "manual"] as const;

/**
 * Every trigger a flow can have (migration 048). The event ones are the
 * Automation triggers, delivered by the same dispatcher.
 */
export type FlowTriggerKind =
  | (typeof CONVERSATION_TRIGGERS)[number]
  | "new_message_received"
  | "new_contact_created"
  | "conversation_assigned"
  | "tag_added"
  | "time_based"
  | "interactive_reply"
  | "conversation_opened"
  | "conversation_closed"
  | "contact_field_changed"
  | "first_daily_message"
  | "no_keyword_match"
  | "ctwa_message"
  | "template_delivered"
  | "sla_breached"
  | "incoming_webhook"
  | "google_sheet_new_row"
  | "ctwa_lead";

export function isEventTrigger(t: string): boolean {
  return !(CONVERSATION_TRIGGERS as readonly string[]).includes(t);
}

// ============================================================
// DB-row shapes (read by the engine via supabaseAdmin)
// ============================================================

export interface FlowRow {
  id: string;
  /** Account tenancy (NOT NULL post-017). The engine looks up active
   *  flows for inbound dispatch using this field. */
  account_id: string;
  /** Author. Used as a default sender-of-record on engine sends and
   *  preserved on flow_runs for log/audit display. */
  user_id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  trigger_type: FlowTriggerKind;
  trigger_config: KeywordTriggerConfig | FirstInboundTriggerConfig | Record<string, unknown>;
  entry_node_id: string | null;
  fallback_policy: FlowFallbackPolicy;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Migration 047: the version new runs use; null = run live nodes. */
  published_version?: number | null;
  has_unpublished_changes?: boolean;
}

export interface FlowNodeRow {
  id: string;
  flow_id: string;
  node_key: string;
  node_type: FlowNodeType;
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
  created_at: string;
}

export interface FlowRunRow {
  id: string;
  flow_id: string;
  /** Tenancy. Matches flows.account_id; NOT NULL post-017. */
  account_id: string;
  /** Audit. Matches the parent flow.user_id. */
  user_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  status:
    | "active"
    | "completed"
    | "handed_off"
    | "timed_out"
    | "paused_by_agent"
    | "failed";
  current_node_key: string | null;
  last_prompt_message_id: string | null;
  vars: Record<string, unknown>;
  reprompt_count: number;
  started_at: string;
  last_advanced_at: string;
  ended_at: string | null;
  end_reason: string | null;
  /** Migration 047: version the run started on (null = live nodes). */
  flow_version?: number | null;
  /** Migration 048: holds the contact's conversation slot (waits for
   *  replies). Background/event runs are false. Absent before 048. */
  exclusive?: boolean;
  /** Migration 048: parked on a delay until this time. */
  resume_at?: string | null;
}

// ============================================================
// Fallback policy (matches flows.fallback_policy JSONB)
// ============================================================

export interface FlowFallbackPolicy {
  /** What to do when the customer reply doesn't match any option. */
  on_unknown_reply: "reprompt" | "handoff" | "ignore";
  /** Max reprompts before applying `on_exhaust`. */
  max_reprompts: number;
  /** Stale-run sweep cutoff. */
  on_timeout_hours: number;
  /** What to do once max_reprompts has been hit. */
  on_exhaust: "handoff" | "end";
}

export const DEFAULT_FALLBACK_POLICY: FlowFallbackPolicy = {
  on_unknown_reply: "reprompt",
  max_reprompts: 2,
  on_timeout_hours: 24,
  on_exhaust: "handoff",
};

// ============================================================
// Engine input — what `dispatchInboundToFlows` accepts
// ============================================================

/**
 * Normalised view of an inbound message that the runner needs. The
 * webhook lifts this out of the raw Meta payload before invoking the
 * runner; keeps the runner free of any WhatsApp-API specifics.
 */
export type ParsedInbound =
  | {
      kind: "text";
      /** The user's typed message body. */
      text: string;
      /** Meta's `messages[0].id` — used for idempotency. */
      meta_message_id: string;
    }
  | {
      kind: "interactive_reply";
      /** The reply_id of the tapped button or list row. */
      reply_id: string;
      /** The visible title of the tapped option (for logging). */
      reply_title: string;
      meta_message_id: string;
    };

export interface DispatchInboundInput {
  /** Account tenancy key. Drives the lookup of active flows and the
   *  idempotency check for previously-seen inbound message_ids. */
  accountId: string;
  /** Sender-of-record for the bot's outbound prompts on engine
   *  sends. Set by the webhook to the WhatsApp config owner. */
  userId: string;
  contactId: string;
  conversationId: string;
  message: ParsedInbound;
}

export interface DispatchInboundResult {
  /**
   * True iff the runner handled the message — it either advanced an
   * existing run or started a new one matching a flow trigger.
   * Webhook uses this to decide whether to also fire automations.
   */
  consumed: boolean;
  /** For diagnostics / logging — null when not consumed. */
  flow_run_id?: string;
  /** For diagnostics. */
  outcome?:
    | "advanced"
    | "started"
    | "completed"
    | "handed_off"
    | "fallback_fired"
    | "duplicate_inbound_ignored"
    | "no_match";
}

// ============================================================
// Helpers — exhaustiveness assertions
// ============================================================

/**
 * Throws a typed compile-time error if the switch over a discriminated
 * union forgets a case. Used in the engine's node-type switch.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled node type: ${JSON.stringify(x)}`);
}
