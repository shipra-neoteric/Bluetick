/**
 * Inbound automation webhooks ("On Webhook" trigger). Pure helpers;
 * the receiver route and the management route use them.
 */

import { createHash, randomBytes } from 'node:crypto';

export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
export const CAPTURE_WINDOW_MS = 10 * 60_000;

export function newWebhookToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Value at a dotted path ("lead.phone", "data.0.mobile"); own keys only. */
export function valueAtPath(body: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = body;
  for (const key of path.split('.').slice(0, 8)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * A bounded, display-safe copy of a payload for "Capture sample": depth
 * ≤ 5, ≤ 50 keys per object, strings ≤ 200 chars, keys that look like
 * secrets masked.
 */
export function sanitizeSample(value: unknown, depth = 0): unknown {
  if (depth > 5) return '…';
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => sanitizeSample(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value).slice(0, 50)) {
    out[k] = /pass|secret|token|authorization|api[_-]?key/i.test(k) ? '••••' : sanitizeSample(v, depth + 1);
  }
  return out;
}

/** Leaf paths of a sample, for the field-mapping picker. */
export function samplePaths(value: unknown, prefix = '', out: string[] = []): string[] {
  if (out.length >= 200) return out;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) samplePaths(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out.push(prefix);
  }
  return out;
}

/** Stable replay key: the caller's idempotency header, else a body hash. */
export function dedupeKey(headers: Headers, rawBody: string): string {
  const supplied = headers.get('idempotency-key') ?? headers.get('x-idempotency-key') ?? headers.get('x-request-id');
  if (supplied?.trim()) return `h:${supplied.trim().slice(0, 200)}`;
  return `b:${createHash('sha256').update(rawBody).digest('hex')}`;
}
