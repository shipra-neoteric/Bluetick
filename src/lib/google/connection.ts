/**
 * The account's stored Google connections (migrations 051 + 053): save one
 * after OAuth, list them, hand out a fresh access token for one
 * (refreshing and re-encrypting as needed), and remove one. Server-only —
 * uses the service-role client.
 *
 * A Bluetick account may connect several Google accounts (one row per
 * Google email). Flows store which one they use (google_connection_id);
 * flows saved before that use the account's oldest connection.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { DRIVE_METADATA_SCOPE, GoogleAuthError, refreshAccessToken, revokeToken, type TokenResponse } from './oauth';

/** Refresh this long before Google's expiry. */
const SKEW_MS = 60_000;

interface ConnectionRow {
  id: string;
  account_id: string;
  google_email: string | null;
  refresh_token: string;
  access_token: string | null;
  access_token_expires_at: string | null;
  scope: string | null;
  last_error: string | null;
  connected_at: string;
}

/** One connected Google account, as the UI may see it (no tokens). */
export interface GoogleAccount {
  id: string;
  email: string | null;
  connected_at: string;
  /** Set when Google rejected the stored token: reconnect needed. */
  error: string | null;
  /** false when the account was connected before the Drive scope (no spreadsheet list). */
  can_list: boolean;
}

export interface ConnectionStatus {
  connected: boolean;
  /** Oldest connection (kept for older clients). */
  email: string | null;
  connected_at: string | null;
  error: string | null;
  accounts: GoogleAccount[];
}

export async function listConnections(db: SupabaseClient, accountId: string): Promise<GoogleAccount[]> {
  const { data, error } = await db
    .from('google_connections')
    .select('id, google_email, connected_at, last_error, scope')
    .eq('account_id', accountId)
    .order('connected_at', { ascending: true });
  if (error) throw new Error(`Google connection lookup failed: ${error.message}`);
  return ((data ?? []) as Pick<ConnectionRow, 'id' | 'google_email' | 'connected_at' | 'last_error' | 'scope'>[]).map((r) => ({
    id: r.id,
    email: r.google_email,
    connected_at: r.connected_at,
    error: r.last_error,
    can_list: !r.scope || r.scope.split(' ').includes(DRIVE_METADATA_SCOPE),
  }));
}

export async function getConnectionStatus(db: SupabaseClient, accountId: string): Promise<ConnectionStatus> {
  const accounts = await listConnections(db, accountId);
  const first = accounts[0];
  return {
    connected: accounts.length > 0,
    email: first?.email ?? null,
    connected_at: first?.connected_at ?? null,
    error: first?.error ?? null,
    accounts,
  };
}

/** Stores (or refreshes) the Google account's tokens; returns its connection id. */
export async function saveConnection(
  db: SupabaseClient,
  args: { accountId: string; userId: string; tokens: TokenResponse; email: string | null },
): Promise<string> {
  if (!args.tokens.refresh_token) {
    throw new GoogleAuthError('Google did not return a refresh token. Remove Bluetick from your Google account permissions and connect again.');
  }
  // The email tells two Google accounts apart (unique per Bluetick account).
  if (!args.email) throw new GoogleAuthError('Google did not share the account email. Connect again and allow it.');
  const now = new Date();
  const { data, error } = await db
    .from('google_connections')
    .upsert(
      {
        account_id: args.accountId,
        google_email: args.email,
        refresh_token: encrypt(args.tokens.refresh_token),
        access_token: encrypt(args.tokens.access_token),
        access_token_expires_at: new Date(now.getTime() + args.tokens.expires_in * 1000).toISOString(),
        scope: args.tokens.scope ?? null,
        last_error: null,
        connected_by: args.userId,
        updated_at: now.toISOString(),
      },
      { onConflict: 'account_id,google_email' },
    )
    .select('id')
    .single();
  if (error) throw new Error(`Could not save the Google connection: ${error.message}`);
  return (data as { id: string }).id;
}

/**
 * A valid access token for one of the account's Google connections, or a
 * GoogleAuthError that says what to do (connect / reconnect / pick again).
 * Without `connectionId` (flows saved before migration 053) the oldest
 * connection is used. Never returns an expired token.
 */
export async function getAccessToken(db: SupabaseClient, accountId: string, connectionId?: string | null): Promise<string> {
  let q = db
    .from('google_connections')
    .select('id, refresh_token, access_token, access_token_expires_at')
    .eq('account_id', accountId);
  q = connectionId ? q.eq('id', connectionId) : q.order('connected_at', { ascending: true });
  const { data, error } = await q.limit(1).maybeSingle();
  if (error) throw new GoogleAuthError(`Google connection lookup failed: ${error.message}`);
  const row = data as Pick<ConnectionRow, 'id' | 'refresh_token' | 'access_token' | 'access_token_expires_at'> | null;
  if (!row) {
    throw new GoogleAuthError(
      connectionId
        ? 'The Google account chosen here was disconnected. Pick a Google account again.'
        : 'Google Sheets is not connected. Sign in with Google in the flow, or in Settings → Integrations.',
    );
  }

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
    await markError(db, row.id, 'Stored Google token cannot be read (ENCRYPTION_KEY changed). Reconnect Google.');
    throw new GoogleAuthError('Stored Google token cannot be read. Sign in with Google again.', true);
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
      .eq('id', row.id);
    return t.access_token;
  } catch (err) {
    if (err instanceof GoogleAuthError && err.reconnect) {
      await markError(db, row.id, 'Google access was revoked or expired. Reconnect Google.');
      throw new GoogleAuthError('Google access was revoked or expired. Sign in with Google again.', true);
    }
    throw err;
  }
}

async function markError(db: SupabaseClient, id: string, message: string) {
  await db.from('google_connections').update({ last_error: message, updated_at: new Date().toISOString() }).eq('id', id);
}

/** Disconnects one Google account of this Bluetick account. False if not found. */
export async function removeConnection(db: SupabaseClient, accountId: string, id: string): Promise<boolean> {
  const { data } = await db
    .from('google_connections')
    .select('refresh_token')
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle();
  if (!data) return false;
  const enc = (data as { refresh_token?: string }).refresh_token;
  if (enc) {
    try {
      await revokeToken(decrypt(enc));
    } catch {
      // Unreadable token: deleting the row is still the right outcome.
    }
  }
  await db.from('google_connections').delete().eq('account_id', accountId).eq('id', id);
  return true;
}
