'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CalendarClock, Loader2, Plus, RefreshCw, Users, XCircle, AlertTriangle } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import type { Broadcast, MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { GatedButton } from '@/components/ui/gated-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCan } from '@/hooks/use-can';
import { formatInZone } from '@/lib/inbox/timezone';
import { getBroadcastStatus } from '@/lib/broadcast-status';
import { isMissingSchemaError } from '@/lib/db/schema-compat';
import { TemplatePhonePreview } from '@/components/campaigns/template-phone-preview';
import { memberName, useMembers } from '@/components/campaigns/use-members';

type Tab = 'upcoming' | 'past' | 'canceled';

/**
 * Scheduled Broadcasts: everything created with "Schedule for later".
 * Upcoming ones can be canceled until the worker claims them (the DB
 * guard only allows canceling a scheduled/draft broadcast).
 */
export default function ScheduledBroadcastsPage() {
  const t = useTranslations('Campaigns.scheduled');
  const tStatus = useTranslations('Broadcasts.status');
  const router = useRouter();
  const canSend = useCan('send-messages');
  const members = useMembers();

  const [tab, setTab] = useState<Tab>('upcoming');
  const [rows, setRows] = useState<Broadcast[]>([]);
  const [templates, setTemplates] = useState<Map<string, MessageTemplate>>(new Map());
  const [tagNames, setTagNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toCancel, setToCancel] = useState<Broadcast | null>(null);
  const [canceling, setCanceling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { data, error: err } = await supabase
      .from('broadcasts')
      .select('*')
      .not('scheduled_at', 'is', null)
      .order('scheduled_at', { ascending: true })
      .limit(500);
    if (err) {
      setError(err.message);
      setLoading(false);
      return;
    }
    const list = (data ?? []) as Broadcast[];
    setRows(list);

    const names = [...new Set(list.map((b) => b.template_name))];
    const tagIds = [...new Set(list.map((b) => b.audience_tag_id).filter((x): x is string => !!x))];
    const [{ data: tpl }, { data: tags }] = await Promise.all([
      names.length
        ? supabase.from('message_templates').select('*').in('name', names)
        : Promise.resolve({ data: [] as MessageTemplate[] }),
      tagIds.length
        ? supabase.from('tags').select('id, name').in('id', tagIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    ]);
    setTemplates(
      new Map(((tpl ?? []) as MessageTemplate[]).map((x) => [`${x.name}|${x.language}`, x])),
    );
    setTagNames(new Map(((tags ?? []) as { id: string; name: string }[]).map((x) => [x.id, x.name])));
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    void load();
  }, [load]);

  const visible = useMemo(
    () =>
      rows.filter((b) =>
        tab === 'upcoming'
          ? b.status === 'scheduled'
          : tab === 'canceled'
            ? b.status === 'canceled'
            : b.status !== 'scheduled' && b.status !== 'canceled' && b.status !== 'draft',
      ),
    [rows, tab],
  );

  async function confirmCancel() {
    if (!toCancel) return;
    setCanceling(true);
    const supabase = createClient();
    const { error: err } = await supabase
      .from('broadcasts')
      .update({ status: 'canceled' })
      .eq('id', toCancel.id)
      .eq('status', 'scheduled')
      .select('id')
      .single();
    setCanceling(false);
    if (err) {
      toast.error(
        isMissingSchemaError(err) || err.code === '23514' ? t('cancelNeedsMigration') : t('cancelFailed'),
      );
      return;
    }
    toast.success(t('canceledToast'));
    setToCancel(null);
    void load();
  }

  function templateFor(b: Broadcast) {
    return templates.get(`${b.template_name}|${b.template_language}`) ??
      [...templates.values()].find((x) => x.name === b.template_name);
  }

  function audienceText(b: Broadcast): string {
    if (b.audience_tag_id && tagNames.get(b.audience_tag_id)) return tagNames.get(b.audience_tag_id)!;
    if (b.audience_label) return b.audience_label;
    const type = (b.audience_filter as { type?: string } | undefined)?.type;
    return type === 'all' ? t('allContacts') : t('customAudience');
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            {t('refresh')}
          </Button>
          <GatedButton
            canAct={canSend}
            gateReason="create broadcasts"
            onClick={() => router.push('/broadcasts/new')}
          >
            <Plus className="h-4 w-4" />
            {t('new')}
          </GatedButton>
        </div>
      </div>

      <div className="flex gap-1 border-b border-border" role="tablist">
        {(['upcoming', 'past', 'canceled'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === k
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(`tabs.${k}`)}
          </button>
        ))}
      </div>

      {error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-500">{error}</div>
      ) : loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <CalendarClock className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t(`empty.${tab}`)}</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((b) => {
            const tpl = templateFor(b);
            const tz = b.scheduled_timezone || 'Asia/Kolkata';
            const status = getBroadcastStatus(b.status);
            return (
              <div key={b.id} className="flex flex-col rounded-xl border border-border bg-card">
                <div className="space-y-1 border-b border-border p-4">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/broadcasts/${b.id}`} className="font-medium text-foreground hover:underline">
                      {b.name}
                    </Link>
                    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] ${status.classes}`}>
                      {tStatus(status.label)}
                    </span>
                  </div>
                  <p className="flex items-center gap-1.5 text-sm text-foreground">
                    <CalendarClock className="h-3.5 w-3.5 text-primary" />
                    {b.scheduled_at ? formatInZone(b.scheduled_at, tz) : '—'}
                    <span className="text-xs text-muted-foreground">({tz})</span>
                  </p>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Users className="h-3.5 w-3.5" />
                    {audienceText(b)} · {t('recipients', { count: b.total_recipients })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('createdBy', { name: memberName(members, b.created_by ?? b.user_id) })}
                  </p>
                  {b.hold_reason && (
                    <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {t.has(`hold.${b.hold_reason}`) ? t(`hold.${b.hold_reason}`) : b.hold_reason}
                    </p>
                  )}
                </div>
                <div className="flex-1 p-3">
                  {tpl ? (
                    <TemplatePhonePreview template={tpl} compact />
                  ) : (
                    <p className="text-xs text-muted-foreground">{t('templateMissing', { name: b.template_name })}</p>
                  )}
                </div>
                {b.status === 'scheduled' && (
                  <div className="flex justify-end border-t border-border p-3">
                    <GatedButton
                      canAct={canSend}
                      gateReason="cancel broadcasts"
                      variant="outline"
                      onClick={() => setToCancel(b)}
                    >
                      <XCircle className="h-4 w-4" />
                      {t('cancel')}
                    </GatedButton>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={!!toCancel} onOpenChange={(o) => !o && setToCancel(null)}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('cancelTitle')}</DialogTitle>
            <DialogDescription>{t('cancelDesc', { name: toCancel?.name ?? '' })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToCancel(null)}>
              {t('keep')}
            </Button>
            <Button variant="destructive" onClick={() => void confirmCancel()} disabled={canceling}>
              {canceling && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('cancelConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
