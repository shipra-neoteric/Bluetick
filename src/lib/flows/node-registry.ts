/**
 * Registry for the Bot Studio Flow nodes (migration 047). One place
 * declares each node's outgoing slots and required fields, so the canvas
 * edges, connect/delete handlers, reachability and activation validation
 * stay aligned without a switch case per file. The original ten node
 * types keep their hand-written handling.
 */

import { validateLocation } from "@/lib/whatsapp/meta-api";
import { validateStepsForActivation } from "@/lib/automations/validate";

export interface SlotDef {
  /** Config key holding the target node_key. */
  key: string;
  /** Canvas sourceHandle id. */
  handle: string;
  /** English fallback label (UI translates by handle). */
  label: string;
  optional?: boolean;
}

// Optional: a step with nothing connected after it ends the flow
// (Bot Studio convention; the engine completes the run there).
const NEXT: SlotDef = { key: "next_node_key", handle: "next", label: "Next", optional: true };

export const BOT_STUDIO_SLOTS: Record<string, SlotDef[]> = {
  send_location: [NEXT],
  send_template: [NEXT],
  assign_agent: [NEXT],
  set_field: [NEXT],
  opt_out: [NEXT],
  working_hours: [
    { key: "open_next", handle: "open", label: "Working hours" },
    { key: "closed_next", handle: "closed", label: "Outside hours" },
    { key: "holiday_next", handle: "holiday", label: "Holiday", optional: true },
  ],
  format_value: [NEXT, { key: "error_next", handle: "error", label: "Invalid input", optional: true }],
  ai_reply: [NEXT, { key: "handoff_next", handle: "handoff", label: "Needs a human", optional: true }],
  // Migration 048 — one Flow for everything.
  time_delay: [NEXT],
  wait_until: [NEXT],
  action: [NEXT],
  call_api: [
    { key: "next_node_key", handle: "success", label: "Success", optional: true },
    { key: "failure_next", handle: "failure", label: "Failure", optional: true },
  ],
  // Migration 051 — Google Sheets "Add Row".
  google_sheets: [
    { key: "next_node_key", handle: "success", label: "Success", optional: true },
    { key: "failure_next", handle: "failure", label: "Failure", optional: true },
  ],
};

/**
 * Automation steps a Flow `action` node can run. Waits and conditions
 * are Flow steps of their own (time_delay / wait_until / condition).
 */
export const ACTION_STEP_TYPES = [
  "close_conversation",
  "send_webhook",
  "create_deal",
  "start_flow",
  "update_contact_field",
  "add_tag",
  "remove_tag",
  "assign_conversation",
  "send_message",
  "send_buttons",
  "send_list",
  "send_template",
  "send_location",
  "opt_out",
  "format_date",
  "format_phone",
] as const;

export function isBotStudioNode(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(BOT_STUDIO_SLOTS, type);
}

export function botStudioTargets(type: string, cfg: Record<string, unknown>): string[] {
  return (BOT_STUDIO_SLOTS[type] ?? [])
    .map((s) => cfg[s.key])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

export interface RegistryIssue {
  field?: string;
  message: string;
  severity?: "error" | "warning";
}

const VAR_KEY = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const has = (v: unknown) => typeof v === "string" && v.trim().length > 0;

/** Required-field checks per node (slot checks are generic, below). */
export function botStudioFieldIssues(type: string, cfg: Record<string, unknown>): RegistryIssue[] {
  const out: RegistryIssue[] = [];
  switch (type) {
    case "send_location": {
      const lat = String(cfg.latitude ?? "");
      const lng = String(cfg.longitude ?? "");
      // Variables are checked at run time; literal values here.
      if (!lat.includes("{{") && !lng.includes("{{")) {
        const err = validateLocation(lat, lng);
        if (err) out.push({ field: "latitude", message: `Location: ${err}.` });
      }
      break;
    }
    case "send_template":
      if (!has(cfg.template_name)) out.push({ field: "template_name", message: "Pick an approved template." });
      break;
    case "assign_agent":
      if (!["specific", "round_robin", "random", "last_agent"].includes(String(cfg.mode))) out.push({ field: "mode", message: "Pick how to choose the agent." });
      if (cfg.mode === "specific" && !has(cfg.agent_id)) out.push({ field: "agent_id", message: "Pick the agent to assign." });
      break;
    case "set_field":
      if (!has(cfg.field)) out.push({ field: "field", message: "Pick the attribute to set." });
      if (cfg.mode !== "clear" && !has(cfg.value)) out.push({ field: "value", message: "Enter a value (or choose Clear).", severity: "warning" });
      break;
    case "format_value":
      if (!["date", "phone"].includes(String(cfg.kind))) out.push({ field: "kind", message: "Choose date or phone formatting." });
      if (!has(cfg.input)) out.push({ field: "input", message: "Enter the value to format." });
      if (!VAR_KEY.test(String(cfg.output_var ?? ""))) out.push({ field: "output_var", message: "Output variable must be letters, digits or _." });
      if (cfg.kind === "date" && !has(cfg.output_format)) out.push({ field: "output_format", message: "Enter an output format, e.g. DD MMM YYYY." });
      break;
    case "time_delay": {
      const n = (v: unknown) => Math.max(0, Number(v) || 0);
      const total = n(cfg.days) * 86400 + n(cfg.hours) * 3600 + n(cfg.minutes) * 60 + n(cfg.seconds) + n(cfg.amount) * 60;
      if (total <= 0) out.push({ field: "days", message: "Delay must be more than 0." });
      if (cfg.amount != null && cfg.unit != null && !["minutes", "hours", "days"].includes(String(cfg.unit))) {
        out.push({ field: "unit", message: "Pick minutes, hours or days." });
      }
      break;
    }
    case "wait_until":
      if (!has(cfg.at) && !has(cfg.date)) out.push({ field: "date", message: "Enter the date to wait for." });
      if (has(cfg.time) && !String(cfg.time).includes("{{") && !/^\d{1,2}:\d{2}$/.test(String(cfg.time))) {
        out.push({ field: "time", message: "Time must be 24-hour HH:mm." });
      }
      break;
    case "call_api":
      if (!has(cfg.api_id)) out.push({ field: "api_id", message: "Select an API (or create one)." });
      if (has(cfg.response_var) && !VAR_KEY.test(String(cfg.response_var))) {
        out.push({ field: "response_var", message: "Response variable must be letters, digits or _." });
      }
      break;
    case "google_sheets": {
      if (!has(cfg.spreadsheet_id) || !has(cfg.sheet_name)) {
        out.push({ field: "spreadsheet_id", message: "Pick the spreadsheet and the tab to add the row to." });
        break;
      }
      const cols = Array.isArray(cfg.columns) ? (cfg.columns as { column?: unknown; value?: unknown }[]) : [];
      if (!cols.some((c) => has(c?.column) && has(c?.value))) {
        out.push({ field: "columns", message: "Fill in at least one column." });
      }
      break;
    }
    case "action": {
      if (!(ACTION_STEP_TYPES as readonly string[]).includes(String(cfg.step_type))) {
        out.push({ field: "step_type", message: "Unknown action." });
        break;
      }
      // Same rules as Automations, so a converted automation validates alike.
      for (const i of validateStepsForActivation([
        { step_type: String(cfg.step_type), step_config: (cfg.step_config as Record<string, unknown>) ?? {} },
      ])) {
        out.push({ field: "step_config", message: i.message.charAt(0).toUpperCase() + i.message.slice(1) + "." });
      }
      break;
    }
    case "ai_reply":
      if (!cfg.send && !has(cfg.output_var)) out.push({ field: "output_var", message: "Either send the answer or store it in a variable." });
      if (has(cfg.output_var) && !VAR_KEY.test(String(cfg.output_var))) out.push({ field: "output_var", message: "Output variable must be letters, digits or _." });
      break;
  }
  return out;
}

/** Slot integrity: required slots set, every target exists. */
export function botStudioSlotIssues(type: string, cfg: Record<string, unknown>, knownKeys: Set<string>): RegistryIssue[] {
  const out: RegistryIssue[] = [];
  for (const slot of BOT_STUDIO_SLOTS[type] ?? []) {
    const target = cfg[slot.key];
    if (typeof target !== "string" || !target) {
      if (!slot.optional) out.push({ field: slot.key, message: `"${slot.label}" must point to a next step.` });
    } else if (!knownKeys.has(target)) {
      out.push({ field: slot.key, message: `"${slot.label}" points to a step that doesn't exist ("${target}").` });
    }
  }
  return out;
}

/** Config patch when a canvas edge is dragged from `handle` to `target`. */
export function botStudioConnect(type: string, handle: string, target: string): Record<string, unknown> | null {
  const slot = (BOT_STUDIO_SLOTS[type] ?? []).find((s) => s.handle === handle);
  return slot ? { [slot.key]: target } : null;
}

/** Clear references to a deleted node. Null when nothing changed. */
export function botStudioUnlink(type: string, cfg: Record<string, unknown>, deletedKey: string): Record<string, unknown> | null {
  let dirty = false;
  const next = { ...cfg };
  for (const slot of BOT_STUDIO_SLOTS[type] ?? []) {
    if (next[slot.key] === deletedKey) {
      next[slot.key] = "";
      dirty = true;
    }
  }
  return dirty ? next : null;
}

/** Default config for a freshly added node. */
export function botStudioDefaultConfig(type: string): Record<string, unknown> {
  switch (type) {
    case "send_location":
      return { latitude: "", longitude: "", name: "", address: "", next_node_key: "" };
    case "send_template":
      return { template_name: "", language: "", params: [], next_node_key: "" };
    case "assign_agent":
      return { mode: "round_robin", pool: [], reassign: false, next_node_key: "" };
    case "set_field":
      return { field: "", value: "", mode: "set", next_node_key: "" };
    case "working_hours":
      return { open_next: "", closed_next: "", holiday_next: "" };
    case "opt_out":
      return { next_node_key: "" };
    case "format_value":
      return { kind: "date", input: "", output_var: "formatted", output_format: "DD MMM YYYY", input_format: "auto", next_node_key: "" };
    case "ai_reply":
      return { send: true, output_var: "", instruction: "", next_node_key: "", handoff_next: "" };
    case "time_delay":
      return { days: 0, hours: 1, minutes: 0, seconds: 0, next_node_key: "" };
    case "wait_until":
      return { date: "", time: "09:00", timezone: "Asia/Kolkata", repeat: "none", if_past: "run_now", next_node_key: "" };
    case "action":
      return { step_type: "close_conversation", step_config: {}, next_node_key: "" };
    case "call_api":
      return { api_id: "", response_var: "api_response", next_node_key: "", failure_next: "" };
    case "google_sheets":
      return { spreadsheet_id: "", spreadsheet_title: "", sheet_name: "", headers: [], columns: [], next_node_key: "", failure_next: "" };
    default:
      return {};
  }
}
