'use client';

import { useTranslations } from 'next-intl';
import type { Metric, MetricCounts } from '@/lib/campaigns/broadcast-metrics';
import { rate } from '@/lib/campaigns/broadcast-metrics';

const SHOWN: Metric[] = ['sent', 'delivered', 'unread', 'read', 'replied', 'noResponse', 'failed'];

const TONE: Record<Metric, string> = {
  sent: 'text-primary',
  delivered: 'text-teal-500',
  unread: 'text-slate-500',
  read: 'text-blue-500',
  replied: 'text-indigo-500',
  noResponse: 'text-amber-500',
  failed: 'text-red-500',
  pending: 'text-muted-foreground',
};

/**
 * Metric tiles. With `onSelect`, each tile is a drilldown button that
 * filters the recipient list by the same predicate that produced the
 * number (lib/campaigns/broadcast-metrics).
 */
export function BroadcastMetricsBar({
  counts,
  active,
  onSelect,
  compact = false,
}: {
  counts: MetricCounts;
  active?: Metric | null;
  onSelect?: (m: Metric | null) => void;
  compact?: boolean;
}) {
  const t = useTranslations('Campaigns.metrics');
  return (
    <div className={`grid gap-2 ${compact ? 'grid-cols-4 sm:grid-cols-7' : 'grid-cols-2 sm:grid-cols-4 lg:grid-cols-7'}`}>
      {SHOWN.map((m) => {
        const base = m === 'sent' || m === 'failed' ? counts.total : m === 'replied' || m === 'noResponse' ? counts.sent : counts.sent;
        const body = (
          <>
            <span className={`block font-semibold tabular-nums ${compact ? 'text-sm' : 'text-xl'} ${TONE[m]}`}>
              {counts[m].toLocaleString()}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">{t(m)}</span>
            {!compact && <span className="block text-[10px] text-muted-foreground">{rate(counts[m], base)}%</span>}
          </>
        );
        const cls = `rounded-lg border px-2 py-1.5 text-left ${
          active === m ? 'border-primary bg-primary/5' : 'border-border bg-card'
        }`;
        return onSelect ? (
          <button
            key={m}
            type="button"
            title={t(`${m}Hint`)}
            aria-pressed={active === m}
            onClick={() => onSelect(active === m ? null : m)}
            className={`${cls} hover:border-primary/60`}
          >
            {body}
          </button>
        ) : (
          <div key={m} title={t(`${m}Hint`)} className={cls}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
