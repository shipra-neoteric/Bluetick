/**
 * Event helpers for the Bot Studio automation triggers that originate in
 * the WhatsApp webhook or the cron (first daily message, SLA breach).
 * Lifecycle transitions (assigned / opened / closed / field changed) are
 * captured by database triggers into automation_events instead
 * (migration 047), so they fire whatever made the change.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { zonedParts } from './working-hours';

/**
 * Records the contact's first message of the calendar day in the
 * account's inbox timezone. True exactly once per contact per day —
 * a replayed webhook or a second message the same day returns false.
 */
export async function recordFirstDailyMessage(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; at?: Date },
): Promise<boolean> {
  const { data: settings } = await db.from('inbox_settings').select('timezone').eq('account_id', args.accountId).maybeSingle();
  const tz = (settings as { timezone?: string } | null)?.timezone || 'Asia/Kolkata';
  let day: string;
  try {
    day = zonedParts(args.at ?? new Date(), tz).date;
  } catch {
    day = zonedParts(args.at ?? new Date(), 'Asia/Kolkata').date;
  }
  const { error } = await db.from('contact_daily_firsts').insert({ account_id: args.accountId, contact_id: args.contactId, day });
  // 23505 = already recorded today; missing table = migration 047 not applied.
  return !error;
}

export interface SlaBreach {
  account_id: string;
  conversation_id: string;
  contact_id: string;
  kind: 'first_response' | 'next_response';
  due_at: string;
}

/**
 * Conversations whose SLA target passed while still awaiting a human
 * reply, not yet flagged for this waiting period. Bot messages never
 * stop the clock (awaiting_reply_since is cleared only by human replies,
 * migration 044). Each breach is claimed with a compare-and-set on
 * sla_breached_at, so concurrent crons flag it once.
 */
export async function claimSlaBreaches(db: SupabaseClient, now = new Date(), limit = 100): Promise<SlaBreach[]> {
  const { data: accounts, error } = await db
    .from('inbox_settings')
    .select('account_id, sla_first_response_minutes, sla_next_response_minutes')
    .eq('sla_enabled', true);
  if (error || !accounts?.length) return [];

  const out: SlaBreach[] = [];
  for (const a of accounts as { account_id: string; sla_first_response_minutes: number; sla_next_response_minutes: number }[]) {
    // Is any automation or flow listening? Skip the scan otherwise.
    const { count } = await db
      .from('automations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', a.account_id)
      .eq('is_active', true)
      .eq('trigger_type', 'sla_breached');
    const { count: flowCount } = await db
      .from('flows')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', a.account_id)
      .eq('status', 'active')
      .eq('trigger_type', 'sla_breached');
    if (!count && !flowCount) continue;

    const minMinutes = Math.min(a.sla_first_response_minutes, a.sla_next_response_minutes);
    const { data: convs } = await db
      .from('conversations')
      .select('id, contact_id, awaiting_reply_since, first_human_reply_at, sla_breached_at')
      .eq('account_id', a.account_id)
      .neq('status', 'closed')
      .not('awaiting_reply_since', 'is', null)
      .lte('awaiting_reply_since', new Date(now.getTime() - minMinutes * 60_000).toISOString())
      .limit(limit);
    for (const c of (convs ?? []) as {
      id: string; contact_id: string; awaiting_reply_since: string; first_human_reply_at: string | null; sla_breached_at: string | null;
    }[]) {
      const kind = c.first_human_reply_at ? 'next_response' : 'first_response';
      const minutes = kind === 'first_response' ? a.sla_first_response_minutes : a.sla_next_response_minutes;
      const due = new Date(Date.parse(c.awaiting_reply_since) + minutes * 60_000);
      if (due > now) continue;
      // Already flagged during this waiting period?
      if (c.sla_breached_at && Date.parse(c.sla_breached_at) >= Date.parse(c.awaiting_reply_since)) continue;
      let claim = db.from('conversations').update({ sla_breached_at: now.toISOString() }).eq('id', c.id);
      claim = c.sla_breached_at ? claim.eq('sla_breached_at', c.sla_breached_at) : claim.is('sla_breached_at', null);
      const { data: won } = await claim.select('id');
      if (won?.length) {
        out.push({ account_id: a.account_id, conversation_id: c.id, contact_id: c.contact_id, kind, due_at: due.toISOString() });
      }
    }
  }
  return out;
}
