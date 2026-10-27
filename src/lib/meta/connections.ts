/**
 * Connected Facebook users (migration 054): save after Facebook Login,
 * list for the UI (names only — tokens never leave the server), hand out
 * a decrypted token, and read campaigns / ad sets with it.
 * Server-only — uses the service-role client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { GRAPH_VERSION } from '@/lib/campaigns/ads';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import type { MetaToken } from './oauth';

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TIMEOUT_MS = 15_000;
/** Graph error code for an expired / revoked / invalid token. */
const INVALID_TOKEN = 190;

export interface MetaConnectionInfo {
  id: string;
  fb_user_id: string;
  name: string | null;
  connected_at: string;
  token_expires_at: string | null;
  /** Set when Meta rejected the stored token: reconnect needed. */
  error: string | null;
}

export async function listConnections(db: SupabaseClient, accountId: string): Promise<MetaConnectionInfo[]> {
  const { data, error } = await db
    .from('meta_connections')
    .select('id, fb_user_id, fb_user_name, connected_at, token_expires_at, last_error')
    .eq('account_id', accountId)
    .order('connected_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    fb_user_id: r.fb_user_id as string,
    name: (r.fb_user_name as string | null) ?? null,
    connected_at: r.connected_at as string,
    token_expires_at: (r.token_expires_at as string | null) ?? null,
    error: (r.last_error as string | null) ?? null,
  }));
}

/** Insert or refresh (same Facebook user again = reconnect). Returns the row id. */
export async function saveConnection(
  db: SupabaseClient,
  args: { accountId: string; userId: string; token: MetaToken; fbUserId: string; name: string | null; scope: string[] },
): Promise<string> {
  const now = new Date();
  const { data, error } = await db
    .from('meta_connections')
    .upsert(
      {
        account_id: args.accountId,
        fb_user_id: args.fbUserId,
        fb_user_name: args.name,
        access_token: encrypt(args.token.access_token),
        token_expires_at: args.token.expires_in ? new Date(now.getTime() + args.token.expires_in * 1000).toISOString() : null,
        scope: args.scope.join(','),
        last_error: null,
        connected_by: args.userId,
        updated_at: now.toISOString(),
      },
      { onConflict: 'account_id,fb_user_id' },
    )
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'could not save the Facebook account');
  return data.id as string;
}

export async function deleteConnection(db: SupabaseClient, accountId: string, id: string): Promise<boolean> {
  const { data, error } = await db.from('meta_connections').delete().eq('account_id', accountId).eq('id', id).select('id');
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

export interface UsableToken {
  id: string;
  token: string;
}

/** One connection's token, or null when it is not this account's. */
export async function connectionToken(db: SupabaseClient, accountId: string, id: string): Promise<UsableToken | null> {
  const { data } = await db
    .from('meta_connections')
    .select('id, access_token')
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle();
  if (!data?.access_token) return null;
  try {
    return { id: data.id as string, token: decrypt(data.access_token as string) };
  } catch {
    return null;
  }
}

/** Every working token of the account, healthiest and newest first. */
export async function accountTokens(db: SupabaseClient, accountId: string, max = 3): Promise<UsableToken[]> {
  const { data } = await db
    .from('meta_connections')
    .select('id, access_token, last_error, updated_at')
    .eq('account_id', accountId)
    .order('updated_at', { ascending: false })
    .limit(10);
  const rows = (data ?? []).sort((a, b) => Number(Boolean(a.last_error)) - Number(Boolean(b.last_error)));
  const out: UsableToken[] = [];
  for (const r of rows) {
    if (out.length >= max) break;
    try {
      out.push({ id: r.id as string, token: decrypt(r.access_token as string) });
    } catch {
      /* undecryptable (key rotated): skip */
    }
  }
  return out;
}

export async function markConnectionError(db: SupabaseClient, id: string, message: string | null): Promise<void> {
  await db.from('meta_connections').update({ last_error: message, updated_at: new Date().toISOString() }).eq('id', id);
}

// ── Graph reads ───────────────────────────────────────────────────────

export class MetaGraphError extends Error {
  constructor(message: string, readonly status: number, readonly invalidToken: boolean) {
    super(message);
    this.name = 'MetaGraphError';
  }
}

export async function graphGet<T>(url: string, token: string, timeoutMs = TIMEOUT_MS): Promise<T> {
  const res = await fetch(url.startsWith('http') ? url : `${GRAPH}${url}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
  if (!res.ok || json.error) {
    throw new MetaGraphError(json.error?.message || `Meta error (${res.status})`, res.status, json.error?.code === INVALID_TOKEN);
  }
  return json;
}

interface Page<T> {
  data?: T[];
  paging?: { next?: string };
}

async function pages<T>(first: string, token: string, maxPages: number, cap: number): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = first;
  for (let i = 0; url && i < maxPages && out.length < cap; i++) {
    const page: Page<T> = await graphGet<Page<T>>(url, token);
    out.push(...(page.data ?? []));
    url = page.paging?.next ?? null;
  }
  return out.slice(0, cap);
}

export interface CampaignOption {
  id: string;
  name: string;
  status: string | null;
  ad_account_name: string | null;
  /** Ad sets only: the campaign it belongs to. */
  campaign_name?: string | null;
}

const MAX_AD_ACCOUNTS = 25;
const PER_ACCOUNT = 200;
export const MAX_OPTIONS = 500;

/**
 * Campaigns or ad sets in every ad account this Facebook user can see,
 * active first then by name. `q` filters by name on Meta's side.
 * An ad account that fails (no permission, disabled) is skipped.
 */
export async function listCampaignOptions(
  token: string,
  level: 'campaign' | 'adset',
  q: string,
): Promise<CampaignOption[]> {
  const accounts = await pages<{ id: string; name?: string }>(
    `/me/adaccounts?${new URLSearchParams({ fields: 'id,name', limit: '100' })}`,
    token,
    3,
    MAX_AD_ACCOUNTS,
  );
  const params = new URLSearchParams({
    fields: level === 'campaign' ? 'id,name,effective_status' : 'id,name,effective_status,campaign{name}',
    limit: '100',
  });
  if (q) params.set('filtering', JSON.stringify([{ field: 'name', operator: 'CONTAIN', value: q }]));
  const edge = level === 'campaign' ? 'campaigns' : 'adsets';

  const out: CampaignOption[] = [];
  let firstError: unknown = null;
  // A few ad accounts at a time: one user can have dozens.
  for (let i = 0; i < accounts.length && out.length < MAX_OPTIONS; i += 5) {
    const batch = accounts.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map((a) =>
        pages<{ id: string; name?: string; effective_status?: string; campaign?: { name?: string } }>(
          `/${a.id}/${edge}?${params}`,
          token,
          2,
          PER_ACCOUNT,
        ),
      ),
    );
    results.forEach((r, k) => {
      if (r.status === 'rejected') {
        firstError ??= r.reason;
        return;
      }
      for (const c of r.value) {
        out.push({
          id: c.id,
          name: c.name || c.id,
          status: c.effective_status ?? null,
          ad_account_name: batch[k].name ?? batch[k].id,
          ...(level === 'adset' ? { campaign_name: c.campaign?.name ?? null } : {}),
        });
      }
    });
  }
  // Every ad account failed: surface the error rather than "no campaigns".
  if (out.length === 0 && firstError && accounts.length > 0) throw firstError;
  const rank = (s: string | null) => (s === 'ACTIVE' ? 0 : 1);
  return out
    .sort((a, b) => rank(a.status) - rank(b.status) || a.name.localeCompare(b.name))
    .slice(0, MAX_OPTIONS);
}
