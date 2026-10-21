/**
 * Meta Ads (read-only). Two truthful sources, kept separate in the UI:
 *
 *  - "Click-to-WhatsApp leads": referrals Bluetick itself captured from
 *    inbound webhooks (message_referrals, migration 046). Exact for
 *    chats that reached this number; no spend data.
 *  - "Fetched ads": the Marketing API insights for the connected ad
 *    account — spend, impressions, clicks and Meta's own count of
 *    messaging conversations started.
 *
 * Nothing here creates, edits, pauses or funds ads.
 */

export const GRAPH_VERSION = 'v21.0';
export const MESSAGING_ACTION = 'onsite_conversion.messaging_conversation_started_7d';
const MAX_PAGES = 10;

/** Spend per chat; null (not 0, not ∞) when there were no chats. */
export function costPerChat(spend: number | null | undefined, chats: number | null | undefined): number | null {
  if (spend == null || !chats || chats <= 0) return null;
  return Math.round((spend / chats) * 100) / 100;
}

/** "act_123" or "123" → "act_123"; null when not an ad account id. */
export function normalizeAdAccountId(raw: string): string | null {
  const v = raw.trim().replace(/^act_/i, '');
  return /^\d{5,20}$/.test(v) ? `act_${v}` : null;
}

export function isIsoDate(v: string | null | undefined): v is string {
  return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}

// ── Captured referrals ────────────────────────────────────────────────

export interface ReferralRow {
  contact_id: string | null;
  source_type: string | null;
  source_id: string | null;
  source_url: string | null;
  headline: string | null;
  created_at: string;
}

export interface LeadSummary {
  sourceId: string;
  sourceType: string;
  headline: string | null;
  sourceUrl: string | null;
  /** Distinct contacts who started a chat from this ad/post. */
  chats: number;
  /** Referral messages (a contact can click the same ad twice). */
  clicks: number;
  firstAt: string;
  lastAt: string;
}

export function summarizeReferrals(rows: ReferralRow[]): LeadSummary[] {
  const map = new Map<string, LeadSummary & { contacts: Set<string> }>();
  for (const r of rows) {
    const key = r.source_id || r.source_url || 'unknown';
    let s = map.get(key);
    if (!s) {
      s = {
        sourceId: key,
        sourceType: r.source_type || 'unknown',
        headline: r.headline,
        sourceUrl: r.source_url,
        chats: 0,
        clicks: 0,
        firstAt: r.created_at,
        lastAt: r.created_at,
        contacts: new Set(),
      };
      map.set(key, s);
    }
    s.clicks++;
    if (r.contact_id) s.contacts.add(r.contact_id);
    if (!s.headline && r.headline) s.headline = r.headline;
    if (r.created_at < s.firstAt) s.firstAt = r.created_at;
    if (r.created_at > s.lastAt) s.lastAt = r.created_at;
  }
  return [...map.values()]
    .map(({ contacts, ...s }) => ({ ...s, chats: contacts.size }))
    .sort((a, b) => b.chats - a.chats || b.lastAt.localeCompare(a.lastAt));
}

// ── Marketing API insights ────────────────────────────────────────────

export interface AdInsight {
  adId: string;
  adName: string;
  campaignName: string;
  adsetName: string;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  /** Meta's count of messaging conversations started (7-day attribution). */
  conversations: number | null;
  costPerConversation: number | null;
}

interface RawInsight {
  ad_id?: string;
  ad_name?: string;
  campaign_name?: string;
  adset_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: { action_type: string; value: string }[];
}

const num = (v: string | undefined): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function parseInsights(data: RawInsight[]): AdInsight[] {
  return data.map((r) => {
    const conv = r.actions?.find((a) => a.action_type === MESSAGING_ACTION);
    const conversations = conv ? num(conv.value) : r.actions ? 0 : null;
    const spend = num(r.spend);
    return {
      adId: r.ad_id ?? '',
      adName: r.ad_name ?? '',
      campaignName: r.campaign_name ?? '',
      adsetName: r.adset_name ?? '',
      spend,
      impressions: num(r.impressions),
      clicks: num(r.clicks),
      conversations,
      costPerConversation: costPerChat(spend, conversations),
    };
  });
}

export class AdsApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Read ad-level insights for a date range. GET only. */
export async function fetchAdInsights(
  args: { adAccountId: string; accessToken: string; since: string; until: string },
  doFetch: typeof fetch = fetch,
): Promise<AdInsight[]> {
  const params = new URLSearchParams({
    level: 'ad',
    fields: 'ad_id,ad_name,campaign_name,adset_name,spend,impressions,clicks,actions',
    time_range: JSON.stringify({ since: args.since, until: args.until }),
    limit: '200',
  });
  let url: string | null = `https://graph.facebook.com/${GRAPH_VERSION}/${args.adAccountId}/insights?${params}`;
  const out: RawInsight[] = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const res: Response = await doFetch(url, { headers: { Authorization: `Bearer ${args.accessToken}` } });
    const body = (await res.json().catch(() => ({}))) as {
      data?: RawInsight[];
      paging?: { next?: string };
      error?: { message?: string };
    };
    if (!res.ok) throw new AdsApiError(body.error?.message || `Meta API error ${res.status}`, res.status);
    out.push(...(body.data ?? []));
    url = body.paging?.next ?? null;
  }
  return parseInsights(out);
}
