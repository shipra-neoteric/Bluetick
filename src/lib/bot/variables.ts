/**
 * Shared variable resolution for Flows and Automations.
 *
 * Syntax (all existing forms keep working):
 *   {{vars.key}}             captured answers / step outputs
 *   {{message.text}}         the triggering message (automations)
 *   {{contact.name}}         name, phone, email, company
 *   {{contact.custom.<id>}}  a custom field value (by field id)
 *   {{trigger.<a.b.c>}}      a value from the trigger payload (webhook, event)
 *
 * No expressions, no code: a token either resolves to text or to "".
 * Unknown tokens resolve to "" (the long-standing behaviour of both
 * engines) and are reported by `missingTokens` so the builder can warn.
 */

export interface VariableScope {
  vars?: Record<string, unknown>;
  message?: { text?: string };
  contact?: { name?: string | null; phone?: string | null; email?: string | null; company?: string | null };
  custom?: Record<string, string | null | undefined>;
  trigger?: Record<string, unknown>;
}

const TOKEN = /\{\{\s*([a-zA-Z_][\w]*(?:\.[\w-]+)*)\s*\}\}/g;
const MAX_DEPTH = 6;

function pick(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path.slice(0, MAX_DEPTH)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    // Own properties only — never walk into prototypes.
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function toText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v).slice(0, 2000);
}

export function resolveToken(token: string, scope: VariableScope): string | undefined {
  const [ns, ...rest] = token.split('.');
  switch (ns) {
    case 'vars':
      return rest.length ? toText(pick(scope.vars ?? {}, rest)) : undefined;
    case 'message':
      return rest[0] === 'text' ? toText(scope.message?.text) : undefined;
    case 'contact':
      if (rest[0] === 'custom' && rest[1]) return toText(scope.custom?.[rest[1]]);
      if (['name', 'phone', 'email', 'company'].includes(rest[0] ?? '')) {
        return toText(scope.contact?.[rest[0] as 'name']);
      }
      return undefined;
    case 'trigger':
      return rest.length ? toText(pick(scope.trigger ?? {}, rest)) : undefined;
    default:
      return undefined;
  }
}

export function interpolate(template: string, scope: VariableScope): string {
  if (!template) return '';
  return template.replace(TOKEN, (_, token: string) => resolveToken(token, scope) ?? '');
}

export function missingTokens(template: string, scope: VariableScope): string[] {
  const out: string[] = [];
  for (const m of (template ?? '').matchAll(TOKEN)) {
    if (resolveToken(m[1], scope) === undefined) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** Does this text need contact / custom-field data loaded? */
export function needsContact(...texts: (string | undefined)[]): { contact: boolean; custom: boolean } {
  const all = texts.filter(Boolean).join(' ');
  return { contact: /\{\{\s*contact\./.test(all), custom: /\{\{\s*contact\.custom\./.test(all) };
}

/** Picker entries for the {} button (labels live in the UI). */
export const BUILT_IN_VARIABLES = [
  { token: 'contact.name', group: 'contact' },
  { token: 'contact.phone', group: 'contact' },
  { token: 'contact.email', group: 'contact' },
  { token: 'contact.company', group: 'contact' },
  { token: 'message.text', group: 'message' },
] as const;
