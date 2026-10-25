'use client';

// ============================================================
// IntegrationsPanel — Settings → Integrations
//
// Google Sheets (migration 051): an admin connects one Google account
// for the workspace. Flows then use it for the "On New Row Google Sheet"
// trigger and the "Google Sheets" Add Row step. Tokens stay on the
// server (encrypted); this panel only sees status.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, Sheet, TriangleAlert } from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { RequireRole } from '@/components/auth/require-role';
import { SettingsPanelHead } from './settings-panel-head';

interface GoogleStatus {
  configured?: boolean;
  available?: boolean;
  connected?: boolean;
  email?: string | null;
  connected_at?: string | null;
  error?: string | null;
}

const RESULTS = ['connected', 'denied', 'error', 'forbidden', 'invalid_state', 'missing_scope', 'not_configured'] as const;

export function IntegrationsPanel() {
  const t = useTranslations('Settings.integrations');
  const params = useSearchParams();
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/integrations/google', { cache: 'no-store' });
        const json = (await res.json().catch(() => ({}))) as GoogleStatus;
        if (!cancelled) setStatus(res.ok ? json : { connected: false });
      } catch {
        if (!cancelled) setStatus({ connected: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // Result of the OAuth round trip (?google=…), shown once.
  const result = params.get('google');
  useEffect(() => {
    if (!result || !(RESULTS as readonly string[]).includes(result)) return;
    if (result === 'connected') toast.success(t('results.connected'));
    else toast.error(t(`results.${result}`));
    const url = new URL(window.location.href);
    url.searchParams.delete('google');
    window.history.replaceState(null, '', url.toString());
  }, [result, t]);

  const disconnect = async () => {
    if (!window.confirm(t('disconnectConfirm'))) return;
    setBusy(true);
    const res = await fetch('/api/integrations/google', { method: 'DELETE' }).catch(() => null);
    setBusy(false);
    if (res?.ok) toast.success(t('disconnected'));
    else toast.error(t('disconnectFailed'));
    reload();
  };

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <Card>
        <CardContent className="flex flex-col gap-4 p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10">
              <Sheet className="h-5 w-5 text-emerald-600" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-foreground">Google Sheets</div>
              <p className="mt-0.5 text-sm text-muted-foreground">{t('sheetsDesc')}</p>
            </div>
          </div>

          {status === null ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t('loading')}
            </p>
          ) : status.available === false ? (
            <p className="text-sm text-amber-600">{t('needsMigration')}</p>
          ) : !status.configured && !status.connected ? (
            <p className="flex items-start gap-2 text-sm text-amber-600">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {t('notConfigured')}
            </p>
          ) : status.connected ? (
            <div className="flex flex-col gap-3">
              {status.error ? (
                <p className="flex items-start gap-2 text-sm text-amber-600">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {status.error}
                </p>
              ) : (
                <p className="flex items-center gap-2 text-sm text-foreground">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  {t('connectedAs', { email: status.email ?? 'Google' })}
                </p>
              )}
              <RequireRole min="admin">
                <div className="flex flex-wrap gap-2">
                  {status.error && (
                    <a href="/api/integrations/google/connect" className={buttonVariants()}>
                      {t('reconnect')}
                    </a>
                  )}
                  <Button variant="outline" disabled={busy} onClick={() => void disconnect()}>
                    {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                    {t('disconnect')}
                  </Button>
                </div>
              </RequireRole>
            </div>
          ) : (
            <RequireRole min="admin" fallback={<p className="text-sm text-muted-foreground">{t('adminOnly')}</p>}>
              <div>
                <a href="/api/integrations/google/connect" className={buttonVariants()}>
                  {t('connect')}
                </a>
                <p className="mt-2 text-xs text-muted-foreground">{t('connectHint')}</p>
              </div>
            </RequireRole>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
