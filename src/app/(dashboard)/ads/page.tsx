'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ExternalLink, Loader2, RefreshCw, Search, Settings2, Target } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useCan } from '@/hooks/use-can';
import { isMissingSchemaError } from '@/lib/db/schema-compat';
import { summarizeReferrals, type AdInsight, type ReferralRow } from '@/lib/campaigns/ads';
import { formatDateTime } from '@/lib/campaigns/customers';
import { Button } from '@/components/ui/button';
import { GatedButton } from '@/components/ui/gated-button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type Tab = 'leads' | 'fetched';
const RANGES = [7, 30, 90] as const;

interface Settings {
  available: boolean;
  connected?: boolean;
  ad_account_id?: string;
  currency?: string | null;
  timezone_name?: string | null;
  last_sync_at?: string | null;
  last_error?: string | null;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Ad Performance. Two honest tabs: leads Bluetick captured from
 * Click-to-WhatsApp ads, and read-only insights fetched from Meta.
 * Nothing here changes ads or spend.
 */
export default function AdsPage() {
  const t = useTranslations('Campaigns.ads');
  const canAdmin = useCan('edit-settings');
  const [tab, setTab] = useState<Tab>('leads');
  const [days, setDays] = useState<number>(30);
  const [search, setSearch] = useState('');
  const [range, setRange] = useState(() => {
    const until = new Date();
    return { since: isoDay(new Date(until.getTime() - 29 * 86_400_000)), until: isoDay(until) };
  });

  const [referrals, setReferrals] = useState<ReferralRow[]>([]);
  const [leadsState, setLeadsState] = useState<'loading' | 'ready' | 'notMigrated'>('loading');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [insights, setInsights] = useState<(AdInsight & { bluetickLeads: number })[] | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  function pickDays(n: number) {
    setDays(n);
    const until = new Date();
    setRange({ since: isoDay(new Date(until.getTime() - (n - 1) * 86_400_000)), until: isoDay(until) });
  }

  const loadLeads = useCallback(async () => {
    setLeadsState('loading');
    const { data, error } = await createClient()
      .from('message_referrals')
      .select('contact_id, source_type, source_id, source_url, headline, created_at')
      .gte('created_at', `${range.since}T00:00:00Z`)
      .lte('created_at', `${range.until}T23:59:59Z`)
      .order('created_at', { ascending: false })
      .limit(5000);
    if (error) {
      setLeadsState(isMissingSchemaError(error) ? 'notMigrated' : 'ready');
      if (!isMissingSchemaError(error)) toast.error(error.message);
      setReferrals([]);
      return;
    }
    setReferrals((data ?? []) as ReferralRow[]);
    setLeadsState('ready');
  }, [range]);

  const loadSettings = useCallback(async () => {
    const res = await fetch('/api/ads/settings', { cache: 'no-store' });
    setSettings(res.ok ? ((await res.json()) as Settings) : { available: false });
  }, []);

  const loadInsights = useCallback(async () => {
    setFetching(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/ads/insights?since=${range.since}&until=${range.until}`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setInsights(body.rows ?? []);
      setCurrency(body.currency ?? null);
      void loadSettings();
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : t('fetchFailed'));
      setInsights(null);
    } finally {
      setFetching(false);
    }
  }, [range, loadSettings, t]);

  useEffect(() => {
    void loadLeads();
  }, [loadLeads]);
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);
  useEffect(() => {
    if (tab === 'fetched' && settings?.connected) void loadInsights();
  }, [tab, settings?.connected, loadInsights]);

  const q = search.trim().toLowerCase();
  const leads = useMemo(
    () =>
      summarizeReferrals(referrals).filter(
        (l) => !q || l.sourceId.toLowerCase().includes(q) || (l.headline ?? '').toLowerCase().includes(q),
      ),
    [referrals, q],
  );
  const shownInsights = useMemo(
    () =>
      (insights ?? []).filter(
        (r) => !q || [r.adName, r.campaignName, r.adsetName, r.adId].some((v) => v.toLowerCase().includes(q)),
      ),
    [insights, q],
  );
  const money = (n: number | null) =>
    n == null ? '—' : currency ? new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(n) : n.toLocaleString('en-IN');
  const count = (n: number | null) => (n == null ? '—' : n.toLocaleString('en-IN'));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <GatedButton canAct={canAdmin} gateReason="connect Meta Ads" variant="outline" onClick={() => setSettingsOpen(true)} disabled={settings?.available === false}>
          <Settings2 className="h-4 w-4" />
          {t('settings')}
        </GatedButton>
      </div>

      <div className="flex gap-1 border-b border-border" role="tablist">
        {(['leads', 'fetched'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {t(`tabs.${k}`)}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('search')} className="pl-8" />
        </div>
        <div className="flex rounded-lg border border-border p-0.5 text-sm">
          {RANGES.map((n) => (
            <button key={n} type="button" onClick={() => pickDays(n)} className={`rounded-md px-2.5 py-1 ${days === n ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}`}>
              {t('lastDays', { days: n })}
            </button>
          ))}
        </div>
        <Input type="date" value={range.since} max={range.until} onChange={(e) => { setDays(0); setRange((r) => ({ ...r, since: e.target.value })); }} className="w-auto" aria-label={t('from')} />
        <Input type="date" value={range.until} min={range.since} onChange={(e) => { setDays(0); setRange((r) => ({ ...r, until: e.target.value })); }} className="w-auto" aria-label={t('to')} />
      </div>

      {tab === 'leads' ? (
        leadsState === 'notMigrated' ? (
          <Notice>{t('notMigrated')}</Notice>
        ) : leadsState === 'loading' ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : leads.length === 0 ? (
          <Notice icon>{t('noLeads')}</Notice>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  {['adOrPost', 'type', 'chats', 'clicks', 'firstLead', 'lastLead'].map((c) => <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">{t(`leadCols.${c}`)}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {leads.map((l) => (
                  <tr key={l.sourceId}>
                    <td className="max-w-[320px] px-3 py-2">
                      <p className="truncate font-medium">{l.headline || l.sourceId}</p>
                      <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                        {l.sourceId}
                        {l.sourceUrl && /^https?:\/\//.test(l.sourceUrl) && (
                          <a href={l.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-primary" aria-label={t('openAd')}><ExternalLink className="h-3 w-3" /></a>
                        )}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{l.sourceType}</td>
                    <td className="px-3 py-2 font-medium tabular-nums">{l.chats}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{l.clicks}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatDateTime(l.firstAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{formatDateTime(l.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : settings === null ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : !settings.available ? (
        <Notice>{t('notMigrated')}</Notice>
      ) : !settings.connected ? (
        <Notice icon>
          {t('notConnected')}{' '}
          {canAdmin && <button type="button" className="text-primary hover:underline" onClick={() => setSettingsOpen(true)}>{t('connect')}</button>}
        </Notice>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {t('account', { id: settings.ad_account_id ?? '' })}
              {settings.last_sync_at && ` · ${t('lastSync', { when: formatDateTime(settings.last_sync_at) })}`}
            </span>
            <Button size="sm" variant="outline" onClick={() => void loadInsights()} disabled={fetching}>
              <RefreshCw className={`h-3.5 w-3.5 ${fetching ? 'animate-spin' : ''}`} />{t('refresh')}
            </Button>
          </div>
          {fetchError && <p className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-500">{fetchError}</p>}
          {fetching && !insights ? (
            <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
          ) : shownInsights.length === 0 ? (
            !fetchError && <Notice icon>{t('noAds')}</Notice>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    {['ad', 'campaign', 'spend', 'impressions', 'clicks', 'conversations', 'costPerConversation', 'bluetickLeads'].map((c) => (
                      <th key={c} title={t.has(`adColsHint.${c}`) ? t(`adColsHint.${c}`) : undefined} className="whitespace-nowrap px-3 py-2 font-medium">{t(`adCols.${c}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shownInsights.map((r) => (
                    <tr key={r.adId}>
                      <td className="max-w-[260px] px-3 py-2"><p className="truncate font-medium">{r.adName || r.adId}</p><p className="truncate text-xs text-muted-foreground">{r.adsetName}</p></td>
                      <td className="max-w-[200px] truncate px-3 py-2 text-muted-foreground">{r.campaignName || '—'}</td>
                      <td className="px-3 py-2 tabular-nums">{money(r.spend)}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{count(r.impressions)}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{count(r.clicks)}</td>
                      <td className="px-3 py-2 tabular-nums">{count(r.conversations)}</td>
                      <td className="px-3 py-2 tabular-nums">{money(r.costPerConversation)}</td>
                      <td className="px-3 py-2 tabular-nums">{r.bluetickLeads}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {settings?.available && (
        <AdsSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} settings={settings} onSaved={() => void loadSettings()} />
      )}
    </div>
  );
}

function Notice({ children, icon }: { children: React.ReactNode; icon?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-14 text-center text-sm text-muted-foreground">
      {icon && <Target className="h-8 w-8" />}
      <p className="max-w-lg">{children}</p>
    </div>
  );
}

function AdsSettingsDialog({
  open,
  onOpenChange,
  settings,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  settings: Settings;
  onSaved: () => void;
}) {
  const t = useTranslations('Campaigns.ads');
  const [adAccountId, setAdAccountId] = useState(settings.ad_account_id ?? '');
  const [token, setToken] = useState('');
  const [currencyCode, setCurrencyCode] = useState(settings.currency ?? 'INR');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch('/api/ads/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ad_account_id: adAccountId, access_token: token || undefined, currency: currencyCode }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      toast.success(t('saved'));
      setToken('');
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    const res = await fetch('/api/ads/settings', { method: 'DELETE' });
    setBusy(false);
    if (res.ok) {
      toast.success(t('disconnected'));
      onSaved();
      onOpenChange(false);
    } else toast.error(t('saveFailed'));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settingsTitle')}</DialogTitle>
          <DialogDescription>{t('settingsDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1 text-sm">
            {t('adAccountId')}
            <Input value={adAccountId} onChange={(e) => setAdAccountId(e.target.value)} placeholder="act_1234567890" />
          </label>
          <label className="block space-y-1 text-sm">
            {t('token')}
            <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={settings.connected ? t('tokenKeep') : ''} />
            <span className="block text-xs text-muted-foreground">{t('tokenHint')}</span>
          </label>
          <label className="block space-y-1 text-sm">
            {t('currency')}
            <Input value={currencyCode} maxLength={3} onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())} />
          </label>
          {settings.last_error && <p className="text-xs text-red-500">{t('lastError', { error: settings.last_error })}</p>}
        </div>
        <DialogFooter className="sm:justify-between">
          {settings.connected ? (
            <Button variant="outline" onClick={() => void disconnect()} disabled={busy}>{t('disconnect')}</Button>
          ) : <span />}
          <Button onClick={() => void save()} disabled={busy || !adAccountId.trim() || (!settings.connected && !token.trim())}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
