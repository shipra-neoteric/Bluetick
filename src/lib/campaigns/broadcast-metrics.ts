/**
 * Broadcast metrics. ONE predicate set drives both the
 * numbers and the drilldown lists, so a metric's count always equals
 * the length of the list it opens.
 *
 * Recipient status is a ladder (pending → sent → delivered → read →
 * replied, or failed) and the broadcasts.*_count columns are cumulative
 * over it (migration 005): a 'replied' row also counts as read,
 * delivered and sent. The predicates below follow the same ladder.
 */

import type { RecipientStatus } from '@/types';

export const METRICS = ['sent', 'delivered', 'unread', 'read', 'replied', 'noResponse', 'failed', 'pending'] as const;
export type Metric = (typeof METRICS)[number];

/** Recipient statuses included in each metric. */
export const METRIC_STATUSES: Record<Metric, RecipientStatus[]> = {
  sent: ['sent', 'delivered', 'read', 'replied'],
  delivered: ['delivered', 'read', 'replied'],
  // Delivered but no read receipt. Customers who turned read receipts
  // off land here too, which is why the UI says "Unread / no receipt".
  unread: ['delivered'],
  read: ['read', 'replied'],
  replied: ['replied'],
  // Reached WhatsApp, no reply credited (yet).
  noResponse: ['sent', 'delivered', 'read'],
  failed: ['failed'],
  pending: ['pending'],
};

export function isMetric(v: unknown): v is Metric {
  return typeof v === 'string' && (METRICS as readonly string[]).includes(v);
}

export function inMetric(status: string, metric: Metric): boolean {
  return (METRIC_STATUSES[metric] as string[]).includes(status);
}

export type MetricCounts = Record<Metric, number> & { total: number };

/** Counts from recipient rows (exact, used on the detail page). */
export function countMetrics(rows: { status: string }[]): MetricCounts {
  const out = { total: rows.length } as MetricCounts;
  for (const m of METRICS) out[m] = 0;
  for (const r of rows) for (const m of METRICS) if (inMetric(r.status, m)) out[m]++;
  return out;
}

/**
 * Counts from the broadcast row's cumulative columns (cheap, used on
 * history cards). Same definitions as {@link countMetrics}.
 */
export function metricsFromBroadcast(b: {
  total_recipients: number;
  sent_count: number;
  delivered_count: number;
  read_count: number;
  replied_count: number;
  failed_count: number;
}): MetricCounts {
  const nn = (n: number) => Math.max(0, n || 0);
  return {
    total: nn(b.total_recipients),
    sent: nn(b.sent_count),
    delivered: nn(b.delivered_count),
    unread: nn(b.delivered_count - b.read_count),
    read: nn(b.read_count),
    replied: nn(b.replied_count),
    noResponse: nn(b.sent_count - b.replied_count),
    failed: nn(b.failed_count),
    pending: nn(b.total_recipients - b.sent_count - b.failed_count),
  };
}

export function rate(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/**
 * Group failures into readable reasons. Meta error strings carry ids
 * and phone numbers; strip those so identical causes group together.
 */
export function normalizeFailureReason(message: string | null | undefined): string {
  const m = (message ?? '').trim();
  if (!m) return 'Unknown error';
  return m
    .replace(/\(#?\d+\)/g, '')
    .replace(/\+?\d[\d\s-]{7,}\d/g, '…')
    .replace(/\b(wamid\.)?[A-Za-z0-9_-]{24,}\b/g, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export function failureReasons(rows: { status: string; error_message?: string | null }[]): { reason: string; count: number }[] {
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.status !== 'failed') continue;
    const key = normalizeFailureReason(r.error_message);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}
