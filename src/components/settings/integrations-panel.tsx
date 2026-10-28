'use client';

// ============================================================
// IntegrationsPanel — Settings → Integrations
//
// Google Sheets (migrations 051 + 053): the workspace can connect
// several Google accounts (agents can add one, also from the Bot
// Builder; admins disconnect). Each flow picks one for the "On New Row
// Google Sheet" trigger and the "Google Sheets" Add Row step. Tokens
// stay on the server (encrypted); this panel only sees status.
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
import { MetaConnectionsCard } from './meta-connections-card';
import { AdAccountCard } from './ad-account-card';

interface GoogleAccount {
  id: string;
  email: string | null;
  connected_at: string;
  error: string | null;
}

interface GoogleStatus {
  configured?: boolean;
  available?: boolean;
  accounts?: GoogleAccount[];
}

const RESULTS = ['connected', 'denied', 'error', 'forbidden', 'invalid_state', 'missing_scope', 'not_configured'] as const;

export function IntegrationsPanel() {
  const t = useTranslations('Settings.integrations');
  const params = useSearchParams();
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/integrations/google', { cache: 'no-store' });
        const json = (await res.json().catch(() => ({}))) as GoogleStatus;
        if (!cancelled) setStatus(res.ok ? json : { accounts: [] });
      } catch {
        if (!cancelled) setStatus({ accounts: [] });
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

  const disconnect = async (a: GoogleAccount) => {
    if (!window.confirm(t('disconnectAccountConfirm', { email: a.email ?? 'Google' }))) return;
    setBusy(a.id);
    const res = await fetch(`/api/integrations/google?id=${encodeURIComponent(a.id)}`, { method: 'DELETE' }).catch(() => null);
    setBusy(null);
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
          ) : (
            <div className="flex flex-col gap-3">
              {(status.accounts ?? []).length > 0 && (
                <div>
                  <div className="mb-1.5 text-sm font-medium text-foreground">{t('accountsTitle')}</div>
                  <ul className="divide-y divide-border rounded-md border">
                    {(status.accounts ?? []).map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                        <div className="min-w-0">
                          <p className="flex items-center gap-2 text-sm text-foreground">
                            {a.error ? (
                              <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600" />
                            ) : (
                              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                            )}
                            <span className="truncate">{a.email ?? 'Google'}</span>
                          </p>
                          {a.error ? (
                            <p className="mt-0.5 text-xs text-amber-600">{a.error}</p>
                          ) : (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {t('connectedOn', { date: new Date(a.connected_at).toLocaleDateString() })}
                            </p>
                          )}
                        </div>
                        <div className="flex gap-2">
                          {a.error && status.configured && (
                            <RequireRole min="agent">
                              <a href="/api/integrations/google/connect" className={buttonVariants({ size: 'sm' })}>
                                {t('reconnect')}
                              </a>
                            </RequireRole>
                          )}
                          <RequireRole min="admin">
                            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void disconnect(a)}>
                              {busy === a.id && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                              {t('disconnect')}
                            </Button>
                          </RequireRole>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {!status.configured ? (
                <p className="flex items-start gap-2 text-sm text-amber-600">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {t('notConfigured')}
                </p>
              ) : (
                <RequireRole min="agent" fallback={<p className="text-sm text-muted-foreground">{t('noPermission')}</p>}>
                  <div>
                    <a href="/api/integrations/google/connect" className={buttonVariants({ variant: (status.accounts ?? []).length ? 'outline' : 'default' })}>
                      {(status.accounts ?? []).length ? t('connectAnother') : t('connect')}
                    </a>
                    <p className="mt-2 text-xs text-muted-foreground">{t('connectHint')}</p>
                  </div>
                </RequireRole>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      {/* Facebook accounts for the "Lead From CTWA" trigger (migration 054). */}
      <MetaConnectionsCard />
      <AdAccountCard />
    </div>
  );
}
