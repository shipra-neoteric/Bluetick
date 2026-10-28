'use client';

// ============================================================
// Settings → Integrations → Meta ad account (migration 046).
// A pasted system-user token (ads_read) for one ad account. The Bot
// Builder's ad picker uses it to show ad / campaign names for the
// Click-to-WhatsApp triggers. Tokens stay on the server (encrypted).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Settings2, Target } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { useCan } from '@/hooks/use-can';
import { formatDateTime } from '@/lib/campaigns/customers';

export interface AdAccountSettings {
  available: boolean;
  connected?: boolean;
  ad_account_id?: string;
  currency?: string | null;
  timezone_name?: string | null;
  last_sync_at?: string | null;
  last_error?: string | null;
}

export function AdAccountCard() {
  const t = useTranslations('Campaigns.ads');
  const canAdmin = useCan('edit-settings');
  const [settings, setSettings] = useState<AdAccountSettings | null>(null);
  const [open, setOpen] = useState(false);

  const [tick, setTick] = useState(0);
  const load = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/ads/settings', { cache: 'no-store' }).catch(() => null);
      const json = res?.ok ? ((await res.json().catch(() => null)) as AdAccountSettings | null) : null;
      if (!cancelled) setSettings(json ?? { available: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return (
    <Card className="mt-4">
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
            <Target className="h-5 w-5 text-blue-600" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-foreground">{t('cardTitle')}</div>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('cardDesc')}</p>
          </div>
        </div>

        {settings === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </p>
        ) : !settings.available ? (
          <p className="text-sm text-amber-600">{t('notMigrated')}</p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 text-sm">
              {settings.connected ? (
                <>
                  <p className="flex items-center gap-2 text-foreground">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${settings.last_error ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                    {t('account', { id: settings.ad_account_id ?? '' })}
                  </p>
                  {settings.last_error ? (
                    <p className="mt-0.5 text-xs text-amber-600">{t('lastError', { error: settings.last_error })}</p>
                  ) : settings.last_sync_at ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{t('lastSync', { when: formatDateTime(settings.last_sync_at) })}</p>
                  ) : null}
                </>
              ) : (
                <p className="text-muted-foreground">{t('cardNotConnected')}</p>
              )}
            </div>
            <GatedButton canAct={canAdmin} gateReason="connect Meta Ads" variant={settings.connected ? 'outline' : 'default'} onClick={() => setOpen(true)}>
              <Settings2 className="h-4 w-4" />
              {settings.connected ? t('settings') : t('connect')}
            </GatedButton>
          </div>
        )}

        {settings?.available && (
          <AdAccountDialog open={open} onOpenChange={setOpen} settings={settings} onSaved={load} />
        )}
      </CardContent>
    </Card>
  );
}

export function AdAccountDialog({
  open,
  onOpenChange,
  settings,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  settings: AdAccountSettings;
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
