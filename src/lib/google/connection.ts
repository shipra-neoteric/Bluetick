/**
 * The account's stored Google connection (migration 051): save it after
 * OAuth, hand out a fresh access token (refreshing and re-encrypting as
 * needed), and remove it. Server-only — uses the service-role client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { GoogleAuthError, refreshAccessToken, revokeToken, type TokenResponse } from './oauth';

/** Refresh this long before Google's expiry. */
const SKEW_MS = 60_000;

interface ConnectionRow {
  account_id: string;
  google_email: string | null;
  refresh_token: string;
  access_token: string | null;
  access_token_expires_at: string | null;
  scope: string | null;
  last_error: string | null;
  connected_at: string;
}

export interface ConnectionStatus {
  connected: boolean;
  email: string | null;
  connected_at: string | null;
  /** Set when Google rejected the stored token: reconnect needed. */
  error: string | null;
}

export async function getConnectionStatus(db: SupabaseClient, accountId: string): Promise<ConnectionStatus> {
  const { data } = await db
    .from('google_connections')
    .select('google_email, connected_at, last_error')
    .eq('account_id', accountId)
    .maybeSingle();
  const row = data as Pick<ConnectionRow, 'google_email' | 'connected_at' | 'last_error'> | null;
  return {
    connected: Boolean(row),
    email: row?.google_email ?? null,
    connected_at: row?.connected_at ?? null,
    error: row?.last_error ?? null,
  };
}

export async function saveConnection(
  db: SupabaseClient,
  args: { accountId: string; userId: string; tokens: TokenResponse; email: string | null },
): Promise<void> {
  if (!args.tokens.refresh_token) {
    throw new GoogleAuthError('Google did not return a refresh token. Remove Bluetick from your Google account permissions and connect again.');
  }
  const now = new Date();
  const { error } = await db.from('google_connections').upsert(
    {
      account_id: args.accountId,
      google_email: args.email,
      refresh_token: encrypt(args.tokens.refresh_token),
      access_token: encrypt(args.tokens.access_token),
      access_token_expires_at: new Date(now.getTime() + args.tokens.expires_in * 1000).toISOString(),
      scope: args.tokens.scope ?? null,
      last_error: null,
      connected_by: args.userId,
      connected_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
    { onConflict: 'account_id' },
  );
  if (error) throw new Error(`Could not save the Google connection: ${error.message}`);
}

/**
 * A valid access token for the account, or a GoogleAuthError that says
 * what to do (connect / reconnect). Never returns an expired token.
 */
export async function getAccessToken(db: SupabaseClient, accountId: string): Promise<string> {
  const { data, error } = await db
    .from('google_connections')
    .select('account_id, refresh_token, access_token, access_token_expires_at')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new GoogleAuthError(`Google connection lookup failed: ${error.message}`);
  const row = data as Pick<ConnectionRow, 'refresh_token' | 'access_token' | 'access_token_expires_at'> | null;
  if (!row) throw new GoogleAuthError('Google Sheets is not connected. An admin can connect it in Settings → Integrations.');

  const exp = row.access_token_expires_at ? Date.parse(row.access_token_expires_at) : 0;
  if (row.access_token && exp - SKEW_MS > Date.now()) {
    try {
      return decrypt(row.access_token);
    } catch {
      // Fall through to a refresh (e.g. ENCRYPTION_KEY rotated).
    }
  }

  let refresh: string;
  try {
    refresh = decrypt(row.refresh_token);
  } catch {
    await markError(db, accountId, 'Stored Google token cannot be read (ENCRYPTION_KEY changed). Reconnect Google.');
    throw new GoogleAuthError('Stored Google token cannot be read. Reconnect Google in Settings → Integrations.', true);
  }
  try {
    const t = await refreshAccessToken(refresh);
    await db
      .from('google_connections')
      .update({
        access_token: encrypt(t.access_token),
        access_token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
        // Google may rotate the refresh token; keep the newest.
        ...(t.refresh_token ? { refresh_token: encrypt(t.refresh_token) } : {}),
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId);
    return t.access_token;
  } catch (err) {
    if (err instanceof GoogleAuthError && err.reconnect) {
      await markError(db, accountId, 'Google access was revoked or expired. Reconnect Google.');
      throw new GoogleAuthError('Google access was revoked or expired. Reconnect Google in Settings → Integrations.', true);
    }
    throw err;
  }
}

async function markError(db: SupabaseClient, accountId: string, message: string) {
  await db
    .from('google_connections')
    .update({ last_error: message, updated_at: new Date().toISOString() })
    .eq('account_id', accountId);
}

export async function removeConnection(db: SupabaseClient, accountId: string): Promise<void> {
  const { data } = await db.from('google_connections').select('refresh_token').eq('account_id', accountId).maybeSingle();
  const enc = (data as { refresh_token?: string } | null)?.refresh_token;
  if (enc) {
    try {
      await revokeToken(decrypt(enc));
    } catch {
      // Unreadable token: deleting the row is still the right outcome.
    }
  }
  await db.from('google_connections').delete().eq('account_id', accountId);
}
