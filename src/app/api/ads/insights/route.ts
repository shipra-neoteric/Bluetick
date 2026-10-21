// ============================================================
// GET /api/ads/insights?since=YYYY-MM-DD&until=YYYY-MM-DD
//
// Read-only Marketing API insights for the connected ad account, plus
// the number of chats Bluetick itself captured per ad in the same range.
// Never creates, edits, pauses or funds anything on Meta.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { isMissingSchemaError } from '@/lib/db/schema-compat';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { AdsApiError, fetchAdInsights, isIsoDate } from '@/lib/campaigns/ads';

const MAX_RANGE_DAYS = 400;

export async function GET(request: Request) {
  try {
    const { accountId, userId } = await requireRole('viewer');
    const limit = checkRateLimit(`ads-insights:${userId}`, { limit: 20, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const url = new URL(request.url);
    const since = url.searchParams.get('since');
    const until = url.searchParams.get('until');
    if (!isIsoDate(since) || !isIsoDate(until) || since > until) {
      return NextResponse.json({ error: 'Pass since and until as YYYY-MM-DD.' }, { status: 400 });
    }
    if ((Date.parse(until) - Date.parse(since)) / 86_400_000 > MAX_RANGE_DAYS) {
      return NextResponse.json({ error: `Pick a range of at most ${MAX_RANGE_DAYS} days.` }, { status: 400 });
    }

    const db = supabaseAdmin();
    const { data: cfg, error } = await db
      .from('ads_integrations')
      .select('ad_account_id, access_token, currency')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      if (isMissingSchemaError(error)) {
        return NextResponse.json({ error: 'Meta Ads needs database migration 046.' }, { status: 409 });
      }
      throw error;
    }
    if (!cfg) return NextResponse.json({ error: 'Connect a Meta ad account first.', code: 'not_connected' }, { status: 409 });

    let rows;
    try {
      rows = await fetchAdInsights({
        adAccountId: cfg.ad_account_id,
        accessToken: decrypt(cfg.access_token),
        since,
        until,
      });
    } catch (err) {
      const message = err instanceof AdsApiError ? err.message : 'Could not reach Meta.';
      await db.from('ads_integrations').update({ last_error: message.slice(0, 500) }).eq('account_id', accountId);
      return NextResponse.json({ error: message }, { status: 502 });
    }

    // Chats Bluetick captured per ad (Click-to-WhatsApp referrals) in range.
    const { data: refs } = await db
      .from('message_referrals')
      .select('source_id, contact_id')
      .eq('account_id', accountId)
      .gte('created_at', `${since}T00:00:00Z`)
      .lte('created_at', `${until}T23:59:59Z`)
      .limit(20_000);
    const leadsByAd = new Map<string, Set<string>>();
    for (const r of (refs ?? []) as { source_id: string | null; contact_id: string | null }[]) {
      if (!r.source_id || !r.contact_id) continue;
      if (!leadsByAd.has(r.source_id)) leadsByAd.set(r.source_id, new Set());
      leadsByAd.get(r.source_id)!.add(r.contact_id);
    }

    await db
      .from('ads_integrations')
      .update({ last_sync_at: new Date().toISOString(), last_error: null })
      .eq('account_id', accountId);

    return NextResponse.json({
      currency: cfg.currency ?? null,
      rows: rows.map((r) => ({ ...r, bluetickLeads: leadsByAd.get(r.adId)?.size ?? 0 })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
