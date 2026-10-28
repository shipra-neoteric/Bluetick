// ============================================================
// GET /api/ads/options — ads to pick in the "Lead From CTWA" and
// "Message from CTWA" triggers (agent+).
//
// Two read-only sources, merged by ad id:
//   1. Click-to-WhatsApp referrals Bluetick already received (no Meta
//      connection needed): ad id, headline, chats, last seen.
//   2. When a Meta ad account is connected (Settings → Integrations): ad and
//      campaign names from the last 90 days of insights.
// A Meta failure never hides source 1; it is reported as `meta: 'error'`.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { fetchAdInsights, summarizeReferrals, type ReferralRow } from '@/lib/campaigns/ads';

const LOOKBACK_DAYS = 180;
const META_DAYS = 90;

export interface AdOption {
  id: string;
  name: string | null;
  campaign: string | null;
  chats: number;
  lastAt: string | null;
}

export async function GET() {
  try {
    const { accountId, userId } = await requireRole('agent');
    const limit = checkRateLimit(`ads-options:${userId}`, { limit: 20, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const db = supabaseAdmin();

    const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
    const { data: refs } = await db
      .from('message_referrals')
      .select('contact_id, source_type, source_id, source_url, headline, created_at')
      .eq('account_id', accountId)
      .gte('created_at', since)
      .not('source_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(20_000);
    const byId = new Map<string, AdOption>();
    for (const s of summarizeReferrals((refs ?? []) as ReferralRow[])) {
      if (!s.sourceId || s.sourceId === 'unknown') continue;
      byId.set(s.sourceId, { id: s.sourceId, name: s.headline, campaign: null, chats: s.chats, lastAt: s.lastAt });
    }

    let meta: 'connected' | 'not_connected' | 'error' = 'not_connected';
    const { data: cfg } = await db
      .from('ads_integrations')
      .select('ad_account_id, access_token')
      .eq('account_id', accountId)
      .maybeSingle();
    if (cfg?.ad_account_id && cfg.access_token) {
      try {
        const until = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - META_DAYS * 86_400_000).toISOString().slice(0, 10);
        const rows = await fetchAdInsights({
          adAccountId: cfg.ad_account_id,
          accessToken: decrypt(cfg.access_token),
          since: from,
          until,
        });
        for (const r of rows) {
          if (!r.adId) continue;
          const cur = byId.get(r.adId);
          byId.set(r.adId, {
            id: r.adId,
            name: r.adName || cur?.name || null,
            campaign: r.campaignName || null,
            chats: cur?.chats ?? 0,
            lastAt: cur?.lastAt ?? null,
          });
        }
        meta = 'connected';
      } catch {
        meta = 'error';
      }
    }

    const ads = [...byId.values()].sort(
      (a, b) => b.chats - a.chats || (b.lastAt ?? '').localeCompare(a.lastAt ?? '') || (a.name ?? '').localeCompare(b.name ?? ''),
    );
    return NextResponse.json({ ads: ads.slice(0, 500), meta });
  } catch (err) {
    return toErrorResponse(err);
  }
}
