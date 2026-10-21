// ============================================================
// /api/ads/settings — Meta Ads connection for the Ad Performance page.
//
//   GET    any member  → connection status (never the token)
//   PUT    admin+      → { ad_account_id, access_token?, currency?, timezone_name? }
//   DELETE admin+      → disconnect
//
// The token is encrypted with the same key as the WhatsApp token and
// stored in ads_integrations (migration 046), a table with RLS on and no
// policies, so only this service-role route can read or write it.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { encrypt } from '@/lib/whatsapp/encryption';
import { isMissingSchemaError } from '@/lib/db/schema-compat';
import { normalizeAdAccountId } from '@/lib/campaigns/ads';

const NOT_MIGRATED = {
  available: false,
  error: 'Meta Ads needs database migration 046.',
};

export async function GET() {
  try {
    const { accountId } = await requireRole('viewer');
    const { data, error } = await supabaseAdmin()
      .from('ads_integrations')
      .select('ad_account_id, currency, timezone_name, last_sync_at, last_error, updated_at')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      if (isMissingSchemaError(error)) return NextResponse.json(NOT_MIGRATED);
      throw error;
    }
    return NextResponse.json({ available: true, connected: !!data, ...(data ?? {}) });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin');
    const body = (await request.json().catch(() => ({}))) as {
      ad_account_id?: string;
      access_token?: string;
      currency?: string;
      timezone_name?: string;
    };
    const adAccountId = normalizeAdAccountId(body.ad_account_id ?? '');
    if (!adAccountId) {
      return NextResponse.json({ error: 'Enter the ad account ID (digits, with or without act_).' }, { status: 400 });
    }
    const db = supabaseAdmin();
    const { data: existing, error: readErr } = await db
      .from('ads_integrations')
      .select('account_id')
      .eq('account_id', accountId)
      .maybeSingle();
    if (readErr) {
      if (isMissingSchemaError(readErr)) return NextResponse.json(NOT_MIGRATED, { status: 409 });
      throw readErr;
    }
    const token = body.access_token?.trim();
    if (!existing && !token) {
      return NextResponse.json({ error: 'An access token is required to connect.' }, { status: 400 });
    }
    const row: Record<string, unknown> = {
      account_id: accountId,
      ad_account_id: adAccountId,
      currency: body.currency?.trim().toUpperCase().slice(0, 3) || null,
      timezone_name: body.timezone_name?.trim().slice(0, 64) || null,
      updated_by: userId,
      updated_at: new Date().toISOString(),
      last_error: null,
    };
    // Leaving the token blank on an existing connection keeps it.
    if (token) row.access_token = encrypt(token);
    const { error } = existing
      ? await db.from('ads_integrations').update(row).eq('account_id', accountId)
      : await db.from('ads_integrations').insert(row);
    if (error) throw error;
    return NextResponse.json({ ok: true, ad_account_id: adAccountId });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const { accountId } = await requireRole('admin');
    const { error } = await supabaseAdmin().from('ads_integrations').delete().eq('account_id', accountId);
    if (error && !isMissingSchemaError(error)) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
