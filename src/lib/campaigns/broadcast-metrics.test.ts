import { describe, expect, it } from 'vitest';
import {
  METRICS,
  countMetrics,
  failureReasons,
  inMetric,
  metricsFromBroadcast,
  normalizeFailureReason,
} from './broadcast-metrics';

const rows = [
  { status: 'pending' },
  { status: 'sent' },
  { status: 'delivered' },
  { status: 'delivered' },
  { status: 'read' },
  { status: 'replied' },
  { status: 'failed', error_message: '(#131026) Message undeliverable to +91 98765 43210' },
  { status: 'failed', error_message: '(#131026) Message undeliverable to +91 91234 56789' },
  { status: 'failed', error_message: null },
];

describe('broadcast metrics', () => {
  it('counts each metric from recipient rows on the status ladder', () => {
    expect(countMetrics(rows)).toEqual({
      total: 9, sent: 5, delivered: 4, unread: 2, read: 2, replied: 1, noResponse: 4, failed: 3, pending: 1,
    });
  });

  it('drilldown predicate selects exactly the counted rows', () => {
    const counts = countMetrics(rows);
    for (const m of METRICS) {
      expect(rows.filter((r) => inMetric(r.status, m))).toHaveLength(counts[m]);
    }
  });

  it('matches the cumulative count columns (migration 005)', () => {
    // The trigger would produce these columns for `rows`.
    const fromColumns = metricsFromBroadcast({
      total_recipients: 9, sent_count: 5, delivered_count: 4, read_count: 2, replied_count: 1, failed_count: 3,
    });
    expect(fromColumns).toEqual(countMetrics(rows));
  });

  it('groups failures by cause, without phone numbers or ids', () => {
    expect(normalizeFailureReason('(#131026) Message undeliverable to +91 98765 43210')).toBe('Message undeliverable to …');
    expect(failureReasons(rows)).toEqual([
      { reason: 'Message undeliverable to …', count: 2 },
      { reason: 'Unknown error', count: 1 },
    ]);
  });

  it('never goes negative on inconsistent columns', () => {
    const m = metricsFromBroadcast({ total_recipients: 1, sent_count: 0, delivered_count: 0, read_count: 2, replied_count: 3, failed_count: 0 });
    expect(m.unread).toBe(0);
    expect(m.noResponse).toBe(0);
  });
});
