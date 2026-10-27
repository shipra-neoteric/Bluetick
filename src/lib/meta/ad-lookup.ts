/**
 * Resolve a Click-to-WhatsApp ad id (from the webhook referral) to its
 * ad set and campaign, so "Lead From CTWA" triggers can follow one
 * campaign / ad set (migration 054).
 *
 * meta_ad_lookup is read first; otherwise each of the account's
 * connected Facebook users is tried (an ad is only visible to users with
 * access to its ad account) and the answer — found or not — is cached.
 *
 * Runs inside the WhatsApp webhook: never throws, short timeouts, and a
 * whole-lookup budget so a slow Graph API cannot hold the webhook.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { accountTokens, graphGet, markConnectionError, MetaGraphError } from './connections';
import { lookupIsFresh, parseAdLookup, type AdLookup } from './ctwa-match';

const PER_CALL_MS = 2_500;
const BUDGET_MS = 4_000;
const AD_ID = /^[0-9]{5,30}$/;

export async function resolveAd(db: SupabaseClient, accountId: string, adId: string | null | undefined): Promise<AdLookup | null> {
  if (!adId || !AD_ID.test(adId)) return null;
  try {
    const { data: cached } = await db
      .from('meta_ad_lookup')
      .select('ad_name, adset_id, adset_name, campaign_id, campaign_name, fetched_at')
      .eq('account_id', accountId)
      .eq('ad_id', adId)
      .maybeSingle();
    if (cached && lookupIsFresh(cached as { campaign_id: string | null; fetched_at: string })) {
      return cached.campaign_id ? toLookup(cached as AdLookup) : null;
    }

    const tokens = await accountTokens(db, accountId);
    if (tokens.length === 0) return cached?.campaign_id ? toLookup(cached as AdLookup) : null;

    const started = Date.now();
    let found: AdLookup | null = null;
    let reached = false;
    for (const t of tokens) {
      const left = BUDGET_MS - (Date.now() - started);
      if (left < 500) break;
      try {
        const json = await graphGet<unknown>(
          `/${adId}?fields=${encodeURIComponent('name,adset{id,name},campaign{id,name}')}`,
          t.token,
          Math.min(PER_CALL_MS, left),
        );
        reached = true;
        found = parseAdLookup(json);
        if (found.campaign_id) break;
      } catch (err) {
        if (err instanceof MetaGraphError) {
          reached = true;
          if (err.invalidToken) await markConnectionError(db, t.id, err.message).catch(() => {});
        }
        // Timeouts / network errors: try the next account, cache nothing.
      }
    }
    // Only cache what Meta actually answered (a timeout is not "not found").
    if (reached) {
      await db
        .from('meta_ad_lookup')
        .upsert({ account_id: accountId, ad_id: adId, ...(found ?? emptyLookup()), fetched_at: new Date().toISOString() })
        .then(undefined, () => {});
    }
    if (found?.campaign_id) return found;
    return cached?.campaign_id ? toLookup(cached as AdLookup) : null;
  } catch (err) {
    console.error('[meta] ad lookup failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

function emptyLookup(): AdLookup {
  return { ad_name: null, adset_id: null, adset_name: null, campaign_id: null, campaign_name: null };
}

function toLookup(r: AdLookup): AdLookup {
  return {
    ad_name: r.ad_name ?? null,
    adset_id: r.adset_id ?? null,
    adset_name: r.adset_name ?? null,
    campaign_id: r.campaign_id ?? null,
    campaign_name: r.campaign_name ?? null,
  };
}
