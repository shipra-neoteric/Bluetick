'use client';

// ============================================================
// Settings → Integrations → Facebook accounts (migration 054).
// Facebook users connected with Facebook Login (ads_read) so the
// "Lead From CTWA" trigger can follow one campaign / ad set. Several per
// workspace; each can be disconnected. Tokens stay on the server.
// The Ad Performance page keeps its own pasted token (Settings → Meta Ads).
// ============================================================

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Megaphone, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { RequireRole } from '@/components/auth/require-role';
import { connectFacebookPopup, useMetaConnections } from '@/components/meta/use-meta-connections';

const RESULTS = ['connected', 'denied', 'error', 'forbidden', 'invalid_state', 'missing_scope', 'not_configured', 'blocked'] as const;

export function MetaConnectionsCard() {
  const t = useTranslations('MetaConnections');
  const params = useSearchParams();
  const { state, reload } = useMetaConnections();
  const [busy, setBusy] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<null | (() => void)>(null);

  const report = (result: string) => {
    if (!(RESULTS as readonly string[]).includes(result)) return;
    if (result === 'connected') toast.success(t('results.connected'));
    else toast.error(t(`results.${result}`));
  };

  // Result of a full-page OAuth round trip (?meta=…), shown once.
  const result = params.get('meta');
  useEffect(() => {
    if (!result) return;
    report(result);
    const url = new URL(window.location.href);
    url.searchParams.delete('meta');
    window.history.replaceState(null, '', url.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const connect = () => {
    const { done, cancel } = connectFacebookPopup();
    setWaiting(() => cancel);
    void done.then((r) => {
      setWaiting(null);
      reload();
      if (r.ok) report('connected');
      else if (r.reason !== 'cancelled') report(RESULTS.includes(r.reason as (typeof RESULTS)[number]) ? r.reason : 'error');
    });
  };

  const disconnect = async (id: string, name: string) => {
    if (!window.confirm(t('disconnectConfirm', { name }))) return;
    setBusy(id);
    const res = await fetch(`/api/meta/connections?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
    setBusy(null);
    if (res?.ok) toast.success(t('disconnected'));
    else toast.error(t('disconnectFailed'));
    reload();
  };

  return (
    <Card className="mt-4">
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/10">
            <Megaphone className="h-5 w-5 text-blue-600" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-foreground">{t('title')}</div>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('description')}</p>
          </div>
        </div>

        {state === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t('loading')}
          </p>
        ) : !state.available ? (
          <p className="text-sm text-amber-600">{t('needsMigration')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {state.connections.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {state.connections.map((c) => {
                  const name = c.name ?? c.fb_user_id;
                  return (
                    <li key={c.id} className="flex items-center gap-3 px-3 py-2">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${c.error ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">{name}</div>
                        {c.error ? (
                          <div className="flex items-start gap-1 text-xs text-amber-600">
                            <TriangleAlert className="mt-px h-3 w-3 shrink-0" /> {t('reconnectNeeded')}
                          </div>
                        ) : (
                          <div className="text-xs text-muted-foreground">
                            {t('connectedOn', { date: new Date(c.connected_at).toLocaleDateString() })}
                          </div>
                        )}
                      </div>
                      <RequireRole min="agent">
                        <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => void disconnect(c.id, name)}>
                          {busy === c.id && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                          {t('disconnect')}
                        </Button>
                      </RequireRole>
                    </li>
                  );
                })}
              </ul>
            )}
            {!state.configured ? (
              <p className="flex items-start gap-2 text-sm text-amber-600">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {t('notConfigured')}
              </p>
            ) : (
              <RequireRole min="agent">
                <div>
                  <Button onClick={connect} disabled={Boolean(waiting)}>
                    {waiting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                    {t('connect')}
                  </Button>
                  {waiting && (
                    <Button variant="ghost" className="ml-2" onClick={() => waiting()}>
                      {t('cancel')}
                    </Button>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">{t('connectHint')}</p>
                </div>
              </RequireRole>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
