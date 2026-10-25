/**
 * Google OAuth for the Sheets integration (migration 051).
 *
 * One Google account per Bluetick account, connected by an admin from
 * Settings → Integrations. Scope "spreadsheets" only (read + append in
 * sheets the connected Google user can open) plus "email" so the UI can
 * show which account is connected. No Google SDK: four plain HTTPS calls.
 *
 * Server env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (a Google Cloud
 * "Web application" OAuth client) and NEXT_PUBLIC_SITE_URL, whose
 * /api/integrations/google/callback must be listed as an authorised
 * redirect URI on that client.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/spreadsheets'];
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TIMEOUT_MS = 15_000;
/** httpOnly cookie holding the OAuth state between connect and callback. */
export const GOOGLE_STATE_COOKIE = 'bt_google_oauth_state';
export const GOOGLE_COOKIE_PATH = '/api/integrations/google';

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && siteUrl());
}

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/+$/, '');
}

export function redirectUri(): string {
  return `${siteUrl()}/api/integrations/google/callback`;
}

export function buildAuthUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    // offline + consent: Google only returns a refresh token on consent.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${q.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

export class GoogleAuthError extends Error {
  /** true = the refresh token is dead; an admin must reconnect. */
  readonly reconnect: boolean;
  constructor(message: string, reconnect = false) {
    super(message);
    this.name = 'GoogleAuthError';
    this.reconnect = reconnect;
  }
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      ...params,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });
  const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & {
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    // invalid_grant = revoked, expired (7-day limit on unverified
    // "Testing" apps) or the user removed access in their Google account.
    const dead = json.error === 'invalid_grant';
    throw new GoogleAuthError(json.error_description || json.error || `Google token error (${res.status})`, dead);
  }
  return json as TokenResponse;
}

export function exchangeCode(code: string): Promise<TokenResponse> {
  return tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
}

export function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  return tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
}

export async function fetchGoogleEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { email?: string };
    return typeof j.email === 'string' ? j.email : null;
  } catch {
    return null;
  }
}

/** Best effort: disconnecting must work even when Google is unreachable. */
export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => undefined);
}
