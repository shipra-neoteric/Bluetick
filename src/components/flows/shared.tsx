/**
 * Shared editor primitives used by both the linear-list and canvas
 * views of a flow.
 *
 * What lives here vs in flow-builder.tsx / flow-canvas.tsx:
 *   - Types and metadata that BOTH views need to render a node
 *     consistently (icon, label, color, 1-line summary).
 *   - Editing-only helpers (defaultConfigFor, slugify, uniqueNodeKey,
 *     BuilderState) stay in flow-builder.tsx until the canvas grows
 *     editing affordances — pulled across in the PR that adds them.
 *
 * Why .tsx and not .ts: NODE_META holds lucide icon components, which
 * are typed as React components; importing them from a .ts module
 * works at runtime but trips TypeScript's
 * `verbatimModuleSyntax`-related linting in some setups. Keeping the
 * file .tsx future-proofs it for inline JSX in node-card renderers.
 */

import {
  BellOff,
  Clock,
  Hourglass,
  Globe,
  CalendarClock,
  Zap,
  FileText,
  MapPin,
  PencilLine,
  Sparkles,
  UserCheck,
  Wand2,
  Flag,
  GitFork,
  Inbox,
  ListChecks,
  ListPlus,
  MessageCircle,
  Paperclip,
  PlayCircle,
  Sheet,
  Tag,
  UserPlus,
  Workflow,
} from 'lucide-react';

import { cn } from '@/lib/utils';

// ============================================================
// Node-type union — single source of truth for every place the UI
// enumerates types (add menu, type pickers, switch statements). Kept
// in lockstep with `FlowNodeType` in src/lib/flows/types.ts (which
// drives the engine's exhaustiveness check); a divergence between the
// two is always a bug.
// ============================================================

export type NodeType =
  | 'start'
  | 'send_message'
  | 'send_buttons'
  | 'send_list'
  | 'send_media'
  | 'collect_input'
  | 'condition'
  | 'set_tag'
  | 'handoff'
  | 'end'
  // Bot Studio (migration 047)
  | 'send_location'
  | 'send_template'
  | 'assign_agent'
  | 'set_field'
  | 'working_hours'
  | 'opt_out'
  | 'format_value'
  | 'ai_reply'
  // One Flow (migration 048)
  | 'time_delay'
  | 'wait_until'
  | 'action'
  | 'call_api'
  // Migration 051
  | 'google_sheets';

export interface BuilderNode {
  node_key: string;
  node_type: NodeType;
  config: Record<string, unknown>;
  /** Optional in v1 — defaults to 0 in the DB. Canvas view reads it
   *  to position nodes; list view ignores it. */
  position_x?: number;
  position_y?: number;
}

// ============================================================
// Per-node-type metadata used to render icons + colours everywhere
// the user sees a node summary. The user-visible label and blurb live
// in the message catalogue (`Flows.builder.nodes.<type>` /
// `Flows.builder.categories.<id>`), not here.
// ============================================================

// ------------------------------------------------------------
// Node categories — buckets the add-step menu groups types under so
// the picker stays scannable as the type list grows, and so a fork
// adding its own node types has an obvious place to slot them.
//
// Note there's no "Events / Triggers" category: in bluetick a flow is
// triggered by flow-level config (`trigger_type`), not by a node on
// the canvas, so `start` is just the entry point under Flow control.
// ------------------------------------------------------------

export type NodeCategory = 'messaging' | 'logic' | 'actions' | 'ai' | 'flow';

/** The order categories render in the add-step menu. */
export const NODE_CATEGORIES: NodeCategory[] = ['messaging', 'logic', 'actions', 'ai', 'flow'];

export const NODE_META: Record<
  NodeType,
  {
    /** English seed for the auto-generated node_key (`slugify(slugSeed)`).
     *  Deliberately NOT translated: node keys are stable identifiers that
     *  surface in analytics and the runner, so they must not change with
     *  the UI locale. */
    slugSeed: string;
    icon: typeof Workflow;
    color: string;
    category: NodeCategory;
  }
> = {
  start: {
    slugSeed: 'Start',
    icon: PlayCircle,
    color: 'text-emerald-400',
    category: 'flow',
  },
  send_message: {
    slugSeed: 'Send message',
    icon: MessageCircle,
    color: 'text-sky-400',
    category: 'messaging',
  },
  send_buttons: {
    slugSeed: 'Send buttons',
    icon: ListChecks,
    color: 'text-primary',
    category: 'messaging',
  },
  send_list: {
    slugSeed: 'Send list',
    icon: ListPlus,
    color: 'text-indigo-400',
    category: 'messaging',
  },
  send_media: {
    slugSeed: 'Send media',
    icon: Paperclip,
    color: 'text-cyan-400',
    category: 'messaging',
  },
  collect_input: {
    slugSeed: 'Collect input',
    icon: Inbox,
    color: 'text-teal-400',
    category: 'logic',
  },
  condition: {
    slugSeed: 'If / else',
    icon: GitFork,
    color: 'text-fuchsia-400',
    category: 'logic',
  },
  set_tag: {
    slugSeed: 'Tag contact',
    icon: Tag,
    color: 'text-pink-400',
    category: 'logic',
  },
  handoff: {
    slugSeed: 'Handoff to agent',
    icon: UserPlus,
    color: 'text-amber-400',
    category: 'flow',
  },
  end: {
    slugSeed: 'End',
    icon: Flag,
    color: 'text-muted-foreground',
    category: 'flow',
  },
  send_location: { slugSeed: 'Send location', icon: MapPin, color: 'text-sky-400', category: 'messaging' },
  send_template: { slugSeed: 'Send template', icon: FileText, color: 'text-sky-400', category: 'messaging' },
  working_hours: { slugSeed: 'Working hours', icon: Clock, color: 'text-amber-400', category: 'logic' },
  format_value: { slugSeed: 'Format value', icon: Wand2, color: 'text-violet-400', category: 'logic' },
  assign_agent: { slugSeed: 'Assign agent', icon: UserCheck, color: 'text-orange-400', category: 'actions' },
  set_field: { slugSeed: 'Set attribute', icon: PencilLine, color: 'text-orange-400', category: 'actions' },
  opt_out: { slugSeed: 'Opt out', icon: BellOff, color: 'text-rose-400', category: 'actions' },
  ai_reply: { slugSeed: 'AI reply', icon: Sparkles, color: 'text-fuchsia-400', category: 'ai' },
  time_delay: { slugSeed: 'Time delay', icon: Hourglass, color: 'text-orange-400', category: 'logic' },
  wait_until: { slugSeed: 'Wait till', icon: CalendarClock, color: 'text-orange-400', category: 'logic' },
  action: { slugSeed: 'Action', icon: Zap, color: 'text-emerald-400', category: 'actions' },
  call_api: { slugSeed: 'Call api', icon: Globe, color: 'text-rose-400', category: 'actions' },
  google_sheets: { slugSeed: 'Google sheets', icon: Sheet, color: 'text-emerald-500', category: 'actions' },
};

/** Every type the add menus / palette offer, in display order. */
export const ADDABLE_NODE_TYPES: NodeType[] = [
  'start',
  'send_buttons',
  'send_list',
  'send_message',
  'send_media',
  'send_location',
  'send_template',
  'collect_input',
  'condition',
  'working_hours',
  'format_value',
  'set_tag',
  'set_field',
  'assign_agent',
  'opt_out',
  'ai_reply',
  'time_delay',
  'wait_until',
  'action',
  'call_api',
  'google_sheets',
  'handoff',
  'end',
];

/** Shown for a node type this version doesn't know (kept, never dropped). */
export const UNKNOWN_NODE_META = {
  slugSeed: 'Step',
  icon: Workflow,
  color: 'text-muted-foreground',
  category: 'flow' as NodeCategory,
};

export function nodeMeta(type: string) {
  return NODE_META[type as NodeType] ?? UNKNOWN_NODE_META;
}

/**
 * Bucket an ordered list of node types by category, preserving both
 * the category order (NODE_CATEGORIES) and the within-category order
 * of the input list. Empty categories are dropped. Used by both the
 * canvas and list add-step menus so they stay in lockstep.
 */
export function groupNodeTypesByCategory(
  types: NodeType[]
): { id: NodeCategory; types: NodeType[] }[] {
  return NODE_CATEGORIES.map((id) => ({
    id,
    types: types.filter((t) => nodeMeta(t).category === id),
  })).filter((group) => group.types.length > 0);
}

// ============================================================
// Per-node-type color system.
//
// Each node type gets its own hue so the canvas reads at a glance —
// what KIND of step is this. Kept as raw oklch (not Tailwind classes)
// so a node card can tint its icon chip, type label, selection ring,
// and edge ports from one source, the way the Flow Builder design
// handoff does. Hues sit in the same oklch family as the app tokens
// in globals.css; they don't replace --primary (the accent), they
// complement it. `nodeColors()` derives the soft/ring/text variants.
// ============================================================

const NODE_HUE: Record<NodeType, { l: number; c: number; h: number }> = {
  start: { l: 0.62, c: 0.13, h: 162 }, // emerald — the start, echoes WhatsApp green
  send_message: { l: 0.6, c: 0.18, h: 293 }, // violet — the workhorse
  send_buttons: { l: 0.62, c: 0.16, h: 254 }, // cobalt
  send_list: { l: 0.62, c: 0.15, h: 277 }, // indigo
  send_media: { l: 0.65, c: 0.12, h: 210 }, // sky
  collect_input: { l: 0.65, c: 0.1, h: 185 }, // teal — capture
  condition: { l: 0.72, c: 0.15, h: 65 }, // amber — a fork in the road
  set_tag: { l: 0.65, c: 0.15, h: 350 }, // pink
  handoff: { l: 0.65, c: 0.17, h: 16 }, // rose — hands off
  end: { l: 0.55, c: 0.01, h: 260 }, // neutral grey — terminal
  send_location: { l: 0.64, c: 0.14, h: 230 },
  send_template: { l: 0.62, c: 0.15, h: 240 },
  working_hours: { l: 0.72, c: 0.14, h: 85 },
  format_value: { l: 0.62, c: 0.14, h: 300 },
  assign_agent: { l: 0.68, c: 0.15, h: 45 },
  set_field: { l: 0.68, c: 0.13, h: 35 },
  opt_out: { l: 0.62, c: 0.17, h: 10 },
  ai_reply: { l: 0.64, c: 0.18, h: 320 },
  time_delay: { l: 0.7, c: 0.15, h: 55 },
  wait_until: { l: 0.7, c: 0.15, h: 55 },
  action: { l: 0.62, c: 0.13, h: 162 },
  call_api: { l: 0.62, c: 0.16, h: 15 },
  google_sheets: { l: 0.6, c: 0.15, h: 150 },
};

export interface NodeColors {
  /** Full-strength hue — icon glyph, selection ring, port fill. */
  solid: string;
  /** ~14% tint — icon chip background, soft fills. */
  soft: string;
  /** ~45% tint — hover border / focus ring. */
  ring: string;
  /** Hue for the uppercase type label, kept readable in BOTH modes. */
  text: string;
}

export function nodeColors(type: NodeType): NodeColors {
  const t = NODE_HUE[type] ?? { l: 0.55, c: 0.01, h: 260 };
  const solid = `oklch(${t.l} ${t.c} ${t.h})`;
  return {
    solid,
    soft: `oklch(${t.l} ${t.c} ${t.h} / 0.14)`,
    ring: `oklch(${t.l} ${t.c} ${t.h} / 0.45)`,
    // Blend the hue toward the live --foreground token so the label
    // holds contrast in BOTH modes: in dark mode --foreground is
    // near-white (the label lightens to read on the dark card), in
    // light mode it's near-black (the label darkens to read on the
    // white card). The old fixed-light value only worked on dark.
    text: `color-mix(in oklch, ${solid}, var(--foreground) 38%)`,
  };
}

// ============================================================
// Shared node icon chip — the per-type colored glyph badge used in
// the canvas node card, list-view card, inspector header, and the
// add-step menu. One component so a styling change (radius, contrast,
// hover) lands in every place at once and the `nodeColors()` lookup
// lives in exactly one spot.
// ============================================================

export function NodeIconChip({
  type,
  size = 24,
  iconSize = 14,
  className,
}: {
  type: NodeType;
  /** Chip side length in px. */
  size?: number;
  /** Glyph side length in px. */
  iconSize?: number;
  className?: string;
}) {
  const meta = nodeMeta(type);
  const c = nodeColors(type);
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg',
        className
      )}
      style={{ width: size, height: size, background: c.soft, color: c.solid }}
    >
      <Icon size={iconSize} />
    </span>
  );
}

// ============================================================
// Pure editing helpers — used by forms in both views.
// ============================================================

/**
 * Coerce an arbitrary string into a stable identifier (node_key,
 * reply_id, etc.). Lowercases, collapses non-alphanumerics into
 * single underscores, and trims leading/trailing underscores. Falls
 * back to `fallback` for inputs that reduce to an empty string.
 */
export function slugify(s: string, fallback: string): string {
  const cleaned = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

// ============================================================
// Summary helpers — short, single-line content previews used in
// collapsed node cards (list view) and node tiles (canvas view).
// Returns null when there's nothing meaningful to show (start/end,
// or a freshly-added node with no fields filled in).
// ============================================================

export function truncate(s: string, max = 80): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}

export function summarizeNode(
  node: BuilderNode,
  t?: (key: string, values?: Record<string, string | number>) => string
): string | null {
  const cfg = node.config;
  switch (node.node_type) {
    case 'start':
    case 'end':
      return null;
    case 'send_message': {
      const text = typeof cfg.text === 'string' ? cfg.text : '';
      return text.length > 0 ? truncate(text) : null;
    }
    case 'send_buttons': {
      const text = typeof cfg.text === 'string' ? cfg.text : '';
      const buttons = Array.isArray(cfg.buttons)
        ? (cfg.buttons as Array<Record<string, unknown>>)
        : [];
      const titles = buttons
        .map((b) => (typeof b.title === 'string' ? b.title : ''))
        .filter(Boolean)
        .join(' / ');
      if (text.length > 0) {
        return titles
          ? `${truncate(text, 40)} · ${truncate(titles, 35)}`
          : truncate(text);
      }
      return titles || null;
    }
    case 'send_list': {
      const text = typeof cfg.text === 'string' ? cfg.text : '';
      const sections = Array.isArray(cfg.sections)
        ? (cfg.sections as Array<Record<string, unknown>>)
        : [];
      const rowCount = sections.reduce<number>((sum, s) => {
        const rows = Array.isArray(s.rows) ? s.rows : [];
        return sum + rows.length;
      }, 0);
      if (text.length > 0) {
        return rowCount > 0
          ? `${truncate(text, 50)} · ${t ? t('options', { count: rowCount }) : `${rowCount} option${rowCount === 1 ? '' : 's'}`}`
          : truncate(text);
      }
      return rowCount > 0
        ? t
          ? t('optionsAcrossSections', { rowCount, sectionCount: sections.length })
          : `${rowCount} option${rowCount === 1 ? '' : 's'} across ${sections.length} section${sections.length === 1 ? '' : 's'}`
        : null;
    }
    case 'send_media': {
      const mediaType =
        typeof cfg.media_type === 'string' ? cfg.media_type : '';
      const filename = typeof cfg.filename === 'string' ? cfg.filename : '';
      const url = typeof cfg.media_url === 'string' ? cfg.media_url : '';
      const caption = typeof cfg.caption === 'string' ? cfg.caption : '';
      const label = mediaType
        ? t ? t(mediaType) || (mediaType.charAt(0).toUpperCase() + mediaType.slice(1)) : mediaType.charAt(0).toUpperCase() + mediaType.slice(1)
        : t ? t('media') : 'Media';
      if (!url) return t ? t('noFile', { label }) : `${label} (no file uploaded)`;
      const name = filename || url.split('/').pop() || 'file';
      return caption
        ? `${label}: ${truncate(name, 30)} · ${truncate(caption, 40)}`
        : `${label}: ${truncate(name, 60)}`;
    }
    case 'collect_input': {
      const prompt = typeof cfg.prompt_text === 'string' ? cfg.prompt_text : '';
      const varKey = typeof cfg.var_key === 'string' ? cfg.var_key : '';
      if (prompt.length > 0) {
        return varKey
          ? `${truncate(prompt, 50)} → vars.${varKey}`
          : truncate(prompt);
      }
      return varKey ? `→ vars.${varKey}` : null;
    }
    case 'condition': {
      const subjectKey =
        typeof cfg.subject_key === 'string' ? cfg.subject_key : '';
      if (!subjectKey) return null;
      const subject =
        cfg.subject === 'tag'
          ? 'tag'
          : cfg.subject === 'contact_field'
            ? 'field'
            : 'var';
      const subjectStr =
        subject === 'tag'
          ? t ? t('hasTag', { tag: truncate(subjectKey, 24) }) : `has tag ${truncate(subjectKey, 24)}`
          : `${subject}.${subjectKey}`;
      const op =
        cfg.operator === 'equals'
          ? '=='
          : cfg.operator === 'contains'
            ? t ? t('opContains') : 'contains'
            : cfg.operator === 'present'
              ? t ? t('opExists') : 'exists'
              : cfg.operator === 'absent'
                ? t ? t('opMissing') : 'missing'
                : '';
      const value = typeof cfg.value === 'string' ? cfg.value : '';
      const valStr =
        (cfg.operator === 'equals' || cfg.operator === 'contains') && value
          ? ` "${truncate(value, 20)}"`
          : '';
      return subject === 'tag' ? subjectStr : `${subjectStr} ${op}${valStr}`;
    }
    case 'set_tag': {
      const mode = cfg.mode === 'remove' ? (t ? t('modeRemove') : 'Remove') : (t ? t('modeAdd') : 'Add');
      const tagId = typeof cfg.tag_id === 'string' ? cfg.tag_id : '';
      // No tag name available without an async lookup here; show a
      // short prefix of the UUID so users can disambiguate between
      // multiple set_tag nodes at a glance.
      return tagId
        ? t ? t('tagPicked', { mode, tag: tagId.slice(0, 8) }) : `${mode} tag ${tagId.slice(0, 8)}…`
        : t ? t('tagNone', { mode }) : `${mode} tag (none picked)`;
    }
    case 'handoff': {
      const note = typeof cfg.note === 'string' ? cfg.note : '';
      return note.length > 0 ? truncate(note) : null;
    }
    case 'send_location': {
      const name = typeof cfg.name === 'string' ? cfg.name : '';
      const lat = String(cfg.latitude ?? '');
      const lng = String(cfg.longitude ?? '');
      return name || (lat && lng ? `${lat}, ${lng}` : null);
    }
    case 'send_template':
      return typeof cfg.template_name === 'string' && cfg.template_name ? cfg.template_name : null;
    case 'assign_agent':
      return typeof cfg.mode === 'string' ? cfg.mode.replace('_', ' ') : null;
    case 'set_field':
      return typeof cfg.field === 'string' && cfg.field
        ? `${cfg.field.startsWith('custom:') ? 'custom field' : cfg.field} ${cfg.mode === 'clear' ? '× clear' : `= ${truncate(String(cfg.value ?? ''), 30)}`}`
        : null;
    case 'format_value':
      return typeof cfg.output_var === 'string' && cfg.output_var ? `${cfg.kind ?? 'date'} → vars.${cfg.output_var}` : null;
    case 'ai_reply':
      return cfg.send ? (cfg.output_var ? `send + vars.${cfg.output_var}` : 'send answer') : cfg.output_var ? `→ vars.${cfg.output_var}` : null;
    case 'working_hours':
    case 'opt_out':
      return null;
    default:
      // A node type from a newer version: shown, never dropped.
      return null;
  }
}
