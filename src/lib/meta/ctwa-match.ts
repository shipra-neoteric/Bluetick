/**
 * Pure helpers for the Click-to-WhatsApp triggers (migration 054):
 * which ads a "Lead From CTWA" / "Message from CTWA" trigger follows,
 * and how a Graph API ad lookup is read and cached. No I/O here.
 *
 * Trigger config (all optional, older configs have none of these):
 *   meta_connection_id  the Facebook account the campaigns were picked from
 *   track               'all' | 'campaign' | 'adset'  (missing = 'all')
 *   campaign_id / campaign_name, adset_id / adset_name
 *   source_ids          legacy: only these ad ids (still honoured)
 */

export type CtwaTrack = 'all' | 'campaign' | 'adset';

export interface CtwaTrackConfig {
  track?: string;
  campaign_id?: string;
  adset_id?: string;
  source_ids?: string[];
}

/** Ad details the webhook puts in context.trigger. */
export interface AdLookup {
  ad_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
}

export function trackOf(cfg: { track?: unknown } | null | undefined): CtwaTrack {
  return cfg?.track === 'campaign' || cfg?.track === 'adset' ? cfg.track : 'all';
}

/**
 * Does this chat's ad pass the trigger's ad filter? Campaign / ad set
 * need the ad resolved to that campaign / ad set (a chat whose ad could
 * not be looked up does not match). Legacy source_ids, when set, must
 * also contain the ad id.
 */
export function ctwaAdMatches(
  cfg: CtwaTrackConfig | null | undefined,
  adId: string | null | undefined,
  trigger: Record<string, unknown> | null | undefined,
): boolean {
  const ids = (cfg?.source_ids ?? []).filter(Boolean);
  if (ids.length > 0 && !(adId && ids.includes(adId))) return false;
  const track = trackOf(cfg);
  if (track === 'campaign') return Boolean(cfg?.campaign_id && trigger?.campaign_id === cfg.campaign_id);
  if (track === 'adset') return Boolean(cfg?.adset_id && trigger?.adset_id === cfg.adset_id);
  return true;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** GET /{ad_id}?fields=name,adset{id,name},campaign{id,name} → AdLookup. */
export function parseAdLookup(json: unknown): AdLookup {
  const j = (json ?? {}) as { name?: unknown; adset?: { id?: unknown; name?: unknown }; campaign?: { id?: unknown; name?: unknown } };
  return {
    ad_name: str(j.name),
    adset_id: str(j.adset?.id),
    adset_name: str(j.adset?.name),
    campaign_id: str(j.campaign?.id),
    campaign_name: str(j.campaign?.name),
  };
}

/** Found ads are re-read weekly (renames); failed lookups after an hour. */
export const LOOKUP_TTL_MS = 7 * 86_400_000;
export const MISS_TTL_MS = 3_600_000;

export function lookupIsFresh(row: { campaign_id: string | null; fetched_at: string }, now = Date.now()): boolean {
  const age = now - Date.parse(row.fetched_at);
  if (!Number.isFinite(age)) return false;
  return age < (row.campaign_id ? LOOKUP_TTL_MS : MISS_TTL_MS);
}

/** Variables the trigger offers to later steps ({{trigger.<key>}}). */
export const CTWA_TRIGGER_KEYS = [
  'headline',
  'source_id',
  'source_url',
  'body',
  'ad_name',
  'adset_name',
  'campaign_name',
  'campaign_id',
  'adset_id',
] as const;
