/**
 * Facebook Login for the "Lead From CTWA" trigger (migration 054).
 *
 * Any number of Facebook users can be connected per Bluetick account,
 * from Settings → Integrations or straight from the Bot Builder (popup).
 * Scope ads_read (campaigns / ad sets / ads the user can see) plus
 * business_management, without which ad accounts owned by a Business
 * Manager are not listed. Read-only: nothing here edits ads.
 *
 * Flow: dialog/oauth → code → short-lived token → long-lived token
 * (fb_exchange_token, ~60 days) → /me for the person's name.
 *
 * Server env: META_APP_ID and its secret — META_LOGIN_APP_SECRET, or else
 * the first entry of META_APP_SECRET — plus NEXT_PUBLIC_SITE_URL, whose
 * /api/meta/callback must be a "Valid OAuth Redirect URI" in the app's
 * Facebook Login settings.
 */

import { GRAPH_VERSION } from '@/lib/campaigns/ads';
import { parseAppSecrets } from '@/lib/whatsapp/webhook-signature';

export const META_SCOPES = ['ads_read', 'business_management'];
export const ADS_READ_SCOPE = 'ads_read';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TIMEOUT_MS = 15_000;
/** httpOnly cookie holding the OAuth state (+ popup flag) between connect and callback. */
export const META_STATE_COOKIE = 'bt_meta_oauth_state';
export const META_COOKIE_PATH = '/api/meta';

function appId(): string {
  return (process.env.META_APP_ID ?? '').trim();
}

function appSecret(): string {
  return (process.env.META_LOGIN_APP_SECRET ?? '').trim() || parseAppSecrets(process.env.META_APP_SECRET)[0] || '';
}

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/+$/, '');
}

export function metaLoginConfigured(): boolean {
  return Boolean(appId() && appSecret() && siteUrl());
}

/**
 * Where Facebook sends the user back: the origin the login started on, so
 * the state cookie survives (localhost in development); the site URL is
 * the fallback. Each origin must be a Valid OAuth Redirect URI in the app.
 */
export function redirectUri(origin?: string): string {
  return `${(origin || siteUrl()).replace(/\/+$/, '')}/api/meta/callback`;
}

export function buildAuthUrl(state: string, origin?: string): string {
  const q = new URLSearchParams({
    client_id: appId(),
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: META_SCOPES.join(','),
    // Ask again for a permission the user declined last time.
    auth_type: 'rerequest',
    state,
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${q.toString()}`;
}

export class MetaAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaAuthError';
  }
}

interface GraphError {
  error?: { message?: string; code?: number; type?: string };
}

async function graphGet<T>(path: string, params: Record<string, string>, token?: string): Promise<T> {
  const res = await fetch(`${GRAPH}${path}?${new URLSearchParams(params).toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as T & GraphError;
  if (!res.ok || json.error) throw new MetaAuthError(json.error?.message || `Meta error (${res.status})`);
  return json;
}

export interface MetaToken {
  access_token: string;
  /** Seconds; absent for tokens that do not expire. */
  expires_in?: number;
}

/** code → long-lived user token (short-lived only if the exchange fails). */
export async function exchangeCode(code: string, origin?: string): Promise<MetaToken> {
  const short = await graphGet<MetaToken>('/oauth/access_token', {
    client_id: appId(),
    client_secret: appSecret(),
    redirect_uri: redirectUri(origin),
    code,
  });
  try {
    return await graphGet<MetaToken>('/oauth/access_token', {
      grant_type: 'fb_exchange_token',
      client_id: appId(),
      client_secret: appSecret(),
      fb_exchange_token: short.access_token,
    });
  } catch (err) {
    console.warn('[meta-oauth] long-lived exchange failed:', err instanceof Error ? err.message : err);
    return short;
  }
}

export async function fetchMe(token: string): Promise<{ id: string; name: string | null }> {
  const me = await graphGet<{ id?: string; name?: string }>('/me', { fields: 'id,name' }, token);
  if (!me.id) throw new MetaAuthError('Facebook did not return the user id');
  return { id: me.id, name: me.name ?? null };
}

/** Permissions the user actually granted (they can untick some). */
export async function fetchGrantedScopes(token: string): Promise<string[]> {
  const res = await graphGet<{ data?: { permission: string; status: string }[] }>('/me/permissions', {}, token);
  return (res.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission);
}
