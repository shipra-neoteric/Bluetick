/**
 * The Bot Builder's Triggers / Actions catalogue, in display order
 * and sections. Each entry maps to what Bluetick actually runs:
 *   - a trigger → flows.trigger_type (+ starting config),
 *   - an action → a flow node type (+ preset config),
 *   - `locked` → shown, disabled, with the reason (needs an integration
 *     Bluetick doesn't have). Never a dead button.
 * Labels live in messages: BotStudio.builder.items.<id>.
 */

import {
  AlarmClock,
  BellOff,
  BookOpen,
  Bot,
  CalendarClock,
  CheckCircle2,
  Clock,
  FileCheck2,
  FileText,
  Flag,
  GitFork,
  Globe,
  Hourglass,
  Inbox,
  Keyboard,
  ListChecks,
  ListPlus,
  Lock,
  Mail,
  MapPin,
  Megaphone,
  MessageCircle,
  MessageSquare,
  MessageSquareDashed,
  MessagesSquare,
  MousePointerClick,
  Paperclip,
  PencilLine,
  Phone,
  PhoneCall,
  PlayCircle,
  Radio,
  Sheet,
  ShoppingBag,
  Sparkles,
  Tag,
  Tags,
  Target,
  UserCheck,
  UserPlus,
  UserRound,
  Users,
  Wand2,
  Webhook,
  Workflow,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { FlowTriggerKind } from "@/lib/flows/types";
import type { NodeType } from "../shared";

export type CatalogItem =
  | { id: string; kind: "trigger"; trigger: FlowTriggerKind; icon: LucideIcon; color: string; config?: Record<string, unknown> }
  | { id: string; kind: "action"; node: NodeType; icon: LucideIcon; color: string; preset?: Record<string, unknown> }
  | { id: string; kind: "locked"; icon: LucideIcon; color: string };

export interface CatalogSection {
  id: string;
  items: CatalogItem[];
}

const trig = (id: string, trigger: FlowTriggerKind, icon: LucideIcon, color: string, config?: Record<string, unknown>): CatalogItem => ({
  id,
  kind: "trigger",
  trigger,
  icon,
  color,
  config,
});
const act = (id: string, node: NodeType, icon: LucideIcon, color: string, preset?: Record<string, unknown>): CatalogItem => ({
  id,
  kind: "action",
  node,
  icon,
  color,
  preset,
});
const locked = (id: string, icon: LucideIcon, color: string): CatalogItem => ({ id, kind: "locked", icon, color });
const action = (step_type: string, step_config: Record<string, unknown> = {}) => ({ step_type, step_config });

const BLUE = "text-sky-600";
const GREEN = "text-emerald-600";
const ORANGE = "text-orange-500";
const PURPLE = "text-violet-600";
const RED = "text-rose-500";

export const TRIGGER_SECTIONS: CatalogSection[] = [
  {
    id: "message",
    items: [
      trig("ctwa_message", "ctwa_message", MousePointerClick, BLUE),
      trig("conversation_closed", "conversation_closed", CheckCircle2, BLUE),
      trig("first_daily_message", "first_daily_message", MessageSquareDashed, BLUE),
      trig("keyword", "keyword", Mail, BLUE, { keywords: [], match_type: "contains" }),
      trig("new_message_received", "new_message_received", MessagesSquare, BLUE),
      trig("conversation_opened", "conversation_opened", MessageSquare, BLUE),
      trig("no_keyword_match", "no_keyword_match", Keyboard, BLUE),
      trig("first_inbound_message", "first_inbound_message", MessageCircle, BLUE),
      trig("interactive_reply", "interactive_reply", ListChecks, BLUE, { reply_ids: [] }),
      trig("manual", "manual", PlayCircle, BLUE),
    ],
  },
  {
    id: "leads",
    items: [
      locked("lead_ctwa", MousePointerClick, GREEN),
      trig("conversation_assigned", "conversation_assigned", UserPlus, GREEN),
      trig("contact_field_changed", "contact_field_changed", PencilLine, GREEN),
      trig("new_contact_created", "new_contact_created", UserRound, GREEN),
      trig("tag_added", "tag_added", Tag, GREEN, { tag_id: "" }),
    ],
  },
  { id: "templates", items: [trig("template_delivered", "template_delivered", FileCheck2, BLUE)] },
  { id: "scheduling", items: [trig("sla_breached", "sla_breached", AlarmClock, ORANGE)] },
  {
    id: "salesforce",
    items: [locked("salesforce_updated", Users, PURPLE), locked("salesforce_new", Users, PURPLE)],
  },
  {
    id: "sheets",
    items: [locked("sheets_new_row", Sheet, PURPLE), trig("incoming_webhook", "incoming_webhook", Webhook, PURPLE, {})],
  },
];

export const ACTION_SECTIONS: CatalogSection[] = [
  {
    id: "messaging",
    items: [
      locked("send_catalogue", ShoppingBag, BLUE),
      act("send_list", "send_list", ListPlus, BLUE),
      act("send_buttons", "send_buttons", ListChecks, BLUE),
      act("send_location", "send_location", MapPin, BLUE),
      act("send_message", "send_message", MessageCircle, BLUE),
      act("send_media", "send_media", Paperclip, BLUE),
      act("send_template", "send_template", FileText, BLUE),
      act("collect_input", "collect_input", Inbox, BLUE),
    ],
  },
  {
    id: "ai",
    items: [act("ai_reply", "ai_reply", Sparkles, PURPLE), locked("tool_call", Bot, PURPLE)],
  },
  {
    id: "logic",
    items: [
      act("condition", "condition", GitFork, ORANGE),
      act("time_delay", "time_delay", Hourglass, ORANGE),
      act("wait_until", "wait_until", Clock, ORANGE),
      act("working_hours", "working_hours", CalendarClock, ORANGE),
      act("start_flow", "action", Workflow, ORANGE, action("start_flow", { flow_id: "", replace_active: false })),
      act("end", "end", Flag, ORANGE),
    ],
  },
  {
    id: "customer",
    items: [
      act("set_tag", "set_tag", Tags, GREEN),
      act("broadcast_list", "set_tag", Megaphone, GREEN, { mode: "add", variant: "broadcast_list" }),
      act("assign_agent", "assign_agent", UserCheck, GREEN),
      act("close_conversation", "action", XCircle, GREEN, action("close_conversation")),
      locked("custom_event", Radio, GREEN),
      act("opt_out", "opt_out", BellOff, GREEN),
      act("set_field", "set_field", PencilLine, GREEN),
      act("create_deal", "action", BookOpen, GREEN, action("create_deal", { pipeline_id: "", stage_id: "", title: "{{contact.name}}", value: 0 })),
      act("handoff", "handoff", UserPlus, GREEN),
    ],
  },
  {
    id: "data",
    items: [
      act("call_api", "call_api", Globe, RED),
      act("format_date", "format_value", CalendarClock, RED, { kind: "date" }),
      act("format_phone", "format_value", Phone, RED, { kind: "phone", default_country_code: "91", phone_output: "e164" }),
      locked("google_sheets", Sheet, RED),
    ],
  },
  { id: "calls", items: [locked("ai_call", PhoneCall, GREEN)] },
  { id: "facebook", items: [locked("fb_conversion", Target, BLUE)] },
];

/** Catalogue id for a canvas node, so cards show the catalogue name. */
export function itemIdForNode(node: { node_type: string; config: Record<string, unknown> }): string {
  if (node.node_type === "action") {
    // Converted automation webhooks keep their own (POST-only) action.
    const st = String(node.config.step_type ?? "");
    return st === "send_webhook" ? "send_webhook" : st || "action";
  }
  if (node.node_type === "format_value") return node.config.kind === "phone" ? "format_phone" : "format_date";
  if (node.node_type === "set_tag" && node.config.variant === "broadcast_list") return "broadcast_list";
  return node.node_type;
}

export function findItem(id: string): CatalogItem | undefined {
  for (const s of [...TRIGGER_SECTIONS, ...ACTION_SECTIONS]) {
    const hit = s.items.find((i) => i.id === id);
    if (hit) return hit;
  }
  return undefined;
}

export const LOCK_ICON = Lock;
export const FALLBACK_ICON = Wand2;
