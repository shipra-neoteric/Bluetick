/**
 * Pure logic behind the template library (/templates) and the template
 * wizard: status grouping, filtering, and positional-variable helpers.
 */

import type { MessageTemplate, TemplateVariableBinding } from '@/types';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';

export type StatusGroup = 'approved' | 'pending' | 'rejected' | 'other';
export const STATUS_GROUPS: StatusGroup[] = ['approved', 'pending', 'rejected', 'other'];

/** Library tabs. Local drafts / paused / disabled → "other". */
export function statusGroup(status: string | null | undefined): StatusGroup {
  switch ((status ?? '').toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'PENDING':
    case 'IN_APPEAL':
      return 'pending';
    case 'REJECTED':
      return 'rejected';
    default:
      return 'other';
  }
}

export interface TemplateFilter {
  search?: string;
  group?: StatusGroup | 'all';
  category?: string | 'all';
  createdBy?: string | 'all';
  language?: string | 'all';
}

function creatorOf(t: MessageTemplate): string | null {
  return t.created_by ?? t.user_id ?? null;
}

export function filterTemplates(list: MessageTemplate[], f: TemplateFilter): MessageTemplate[] {
  const q = (f.search ?? '').trim().toLowerCase();
  return list.filter((t) => {
    if (f.group && f.group !== 'all' && statusGroup(t.status) !== f.group) return false;
    if (f.category && f.category !== 'all' && t.category !== f.category) return false;
    if (f.createdBy && f.createdBy !== 'all' && creatorOf(t) !== f.createdBy) return false;
    if (f.language && f.language !== 'all' && (t.language ?? '') !== f.language) return false;
    if (q && !t.name.toLowerCase().includes(q) && !t.body_text.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Counts per status group, for the tab badges (before the status filter). */
export function countByGroup(list: MessageTemplate[]): Record<StatusGroup | 'all', number> {
  const out = { all: list.length, approved: 0, pending: 0, rejected: 0, other: 0 };
  for (const t of list) out[statusGroup(t.status)]++;
  return out;
}

/** Next free positional index for a new {{n}} in `texts` (body + header). */
export function nextVariableIndex(...texts: string[]): number {
  const used = texts.flatMap((t) => extractVariableIndices(t ?? ''));
  return used.length ? Math.max(...used) + 1 : 1;
}

/** Insert `{{n}}` at `pos` (end when omitted). Returns the new text and caret. */
export function insertVariable(
  text: string,
  index: number,
  pos: number = text.length,
): { text: string; caret: number } {
  const token = `{{${index}}}`;
  const at = Math.max(0, Math.min(pos, text.length));
  return { text: text.slice(0, at) + token + text.slice(at), caret: at + token.length };
}

/**
 * Meta requires body variables to be {{1}}..{{n}} with no gaps. Returns
 * the missing indices (empty when valid), so the wizard can explain.
 */
export function missingVariableIndices(text: string): number[] {
  const used = [...new Set(extractVariableIndices(text))].sort((a, b) => a - b);
  if (!used.length) return [];
  const missing: number[] = [];
  for (let i = 1; i <= used[used.length - 1]; i++) if (!used.includes(i)) missing.push(i);
  return missing;
}

/** Drop bindings for variables no longer in the text. */
export function pruneBindings(
  bindings: Record<string, TemplateVariableBinding>,
  ...texts: string[]
): Record<string, TemplateVariableBinding> {
  const live = new Set(texts.flatMap((t) => extractVariableIndices(t ?? '')).map(String));
  return Object.fromEntries(Object.entries(bindings).filter(([k]) => live.has(k)));
}

/** Preview label for each variable: sample value, else the bound field name. */
export function variableLabels(
  samples: string[],
  bindings: Record<string, TemplateVariableBinding>,
  fieldLabel: (b: TemplateVariableBinding) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, b] of Object.entries(bindings)) out[k] = fieldLabel(b);
  samples.forEach((v, i) => {
    if (v?.trim()) out[String(i + 1)] = v.trim();
  });
  return out;
}
