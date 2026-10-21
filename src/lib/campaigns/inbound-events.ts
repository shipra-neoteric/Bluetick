/**
 * Campaign-related side effects of an inbound WhatsApp message, called
 * from the webhook after the message is stored. Every function is
 * best-effort (never throws into the webhook) and tolerant of a database
 * that hasn't applied migration 046 yet.
 *
 *  - attributeBroadcastReply: credits a broadcast recipient as "replied".
 *    1) If the customer replied to the broadcast message itself (reply
 *       context = that message's wamid) → attribution 'context'.
 *    2) Otherwise the most recent broadcast send to this contact within
 *       REPLY_WINDOW_HOURS → attribution 'window' (labelled "inferred" in
 *       the UI). Older broadcasts are never credited — previously any
 *       later message, however old the broadcast, was counted.
 *  - captureReferral: stores Click-to-WhatsApp ad referral data.
 *  - handleOptOutButton: a tap on a template button flagged `opt_out`
 *    opts the contact out of marketing (explicit semantics only — never
 *    inferred from a similar-looking label on another button).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingSchemaError } from '@/lib/db/schema-compat';
import type { TemplateButton } from '@/types';

export const REPLY_WINDOW_HOURS = 72;

export interface InboundReferral {
  source_url?: string;
  source_id?: string;
  source_type?: string;
  headline?: string;
  body?: string;
  ctwa_clid?: string;
}

interface RecipientRow {
  id: string;
  sent_at: string | null;
  created_at: string;
}

/** Pick which recipient row (if any) a reply without context credits. */
export function pickWindowedRecipient(rows: RecipientRow[], now: Date): RecipientRow | null {
  const cutoff = now.getTime() - REPLY_WINDOW_HOURS * 3600_000;
  const recent = rows
    .filter((r) => Date.parse(r.sent_at ?? r.created_at) >= cutoff)
    .sort((a, b) => Date.parse(b.sent_at ?? b.created_at) - Date.parse(a.sent_at ?? a.created_at));
  return recent[0] ?? null;
}

async function markReplied(db: SupabaseClient, id: string, attribution: 'context' | 'window') {
  const patch = { status: 'replied', replied_at: new Date().toISOString(), reply_attribution: attribution };
  const { error } = await db.from('broadcast_recipients').update(patch).eq('id', id);
  if (error && isMissingSchemaError(error)) {
    // Pre-046: no reply_attribution column.
    const { reply_attribution: _drop, ...legacy } = patch;
    void _drop;
    await db.from('broadcast_recipients').update(legacy).eq('id', id);
  } else if (error) {
    console.error('[campaigns] mark replied failed:', error.message);
  }
}

export async function attributeBroadcastReply(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; contextWamid?: string | null; now?: Date },
): Promise<'context' | 'window' | null> {
  const now = args.now ?? new Date();
  try {
    if (args.contextWamid) {
      const { data } = await db
        .from('broadcast_recipients')
        .select('id, status, broadcasts!inner(account_id)')
        .eq('whatsapp_message_id', args.contextWamid)
        .eq('broadcasts.account_id', args.accountId)
        .limit(1);
      const row = (data ?? [])[0] as { id: string; status: string } | undefined;
      if (row) {
        if (['sent', 'delivered', 'read'].includes(row.status)) await markReplied(db, row.id, 'context');
        return 'context';
      }
    }
    const since = new Date(now.getTime() - REPLY_WINDOW_HOURS * 3600_000).toISOString();
    const { data: rows } = await db
      .from('broadcast_recipients')
      .select('id, sent_at, created_at, broadcasts!inner(account_id)')
      .eq('contact_id', args.contactId)
      .eq('broadcasts.account_id', args.accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5);
    const target = pickWindowedRecipient((rows ?? []) as RecipientRow[], now);
    if (!target) return null;
    await markReplied(db, target.id, 'window');
    return 'window';
  } catch (err) {
    console.error('[campaigns] reply attribution failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function captureReferral(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    conversationId: string;
    waMessageId: string;
    referral: InboundReferral | undefined;
  },
): Promise<boolean> {
  const r = args.referral;
  if (!r || (!r.source_id && !r.source_url && !r.ctwa_clid)) return false;
  try {
    const { error } = await db.from('message_referrals').insert({
      account_id: args.accountId,
      contact_id: args.contactId,
      conversation_id: args.conversationId,
      wa_message_id: args.waMessageId,
      source_type: r.source_type ?? null,
      source_id: r.source_id ?? null,
      source_url: r.source_url ?? null,
      headline: r.headline?.slice(0, 500) ?? null,
      body: r.body?.slice(0, 2000) ?? null,
      ctwa_clid: r.ctwa_clid ?? null,
    });
    if (error) {
      // 23505 = replayed webhook; missing table = migration 046 not applied.
      if (error.code !== '23505' && !isMissingSchemaError(error)) {
        console.error('[campaigns] referral insert failed:', error.message);
      }
      return false;
    }
    await db.from('contacts').update({ last_ctwa_at: new Date().toISOString() }).eq('id', args.contactId);
    return true;
  } catch (err) {
    console.error('[campaigns] captureReferral failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Is this tap on a button that the template marks as opt-out? */
export function isOptOutTap(buttons: TemplateButton[] | null | undefined, tapped: { text?: string; payload?: string }): boolean {
  const labels = [tapped.text, tapped.payload].filter((s): s is string => !!s).map((s) => s.trim().toLowerCase());
  return (buttons ?? []).some(
    (b) => b.type === 'QUICK_REPLY' && b.opt_out === true
      && labels.includes(b.text.trim().toLowerCase()),
  );
}

export async function handleOptOutButton(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    contextWamid?: string | null;
    button?: { text?: string; payload?: string };
  },
): Promise<boolean> {
  if (!args.button || !args.contextWamid) return false;
  try {
    // Which template did they tap on? Inbox/automation sends are stored as
    // messages; broadcast sends live on broadcast_recipients.
    let templateName: string | null = null;
    const { data: msg } = await db
      .from('messages')
      .select('template_name, conversations!inner(account_id)')
      .eq('message_id', args.contextWamid)
      .eq('conversations.account_id', args.accountId)
      .limit(1);
    templateName = ((msg ?? [])[0] as { template_name?: string | null } | undefined)?.template_name ?? null;
    if (!templateName) {
      const { data: rec } = await db
        .from('broadcast_recipients')
        .select('broadcasts!inner(account_id, template_name)')
        .eq('whatsapp_message_id', args.contextWamid)
        .eq('broadcasts.account_id', args.accountId)
        .limit(1);
      const b = ((rec ?? [])[0] as { broadcasts?: { template_name?: string } | { template_name?: string }[] } | undefined)?.broadcasts;
      templateName = (Array.isArray(b) ? b[0]?.template_name : b?.template_name) ?? null;
    }
    if (!templateName) return false;

    const { data: tpl } = await db
      .from('message_templates')
      .select('buttons')
      .eq('account_id', args.accountId)
      .eq('name', templateName)
      .limit(1);
    const buttons = ((tpl ?? [])[0] as { buttons?: TemplateButton[] } | undefined)?.buttons;
    if (!isOptOutTap(buttons, args.button)) return false;

    const { error } = await db
      .from('contacts')
      .update({
        opt_in_status: 'opted_out',
        opt_out_at: new Date().toISOString(),
        opt_in_source: `Tapped opt-out button on template "${templateName}"`,
        opt_in_scope: 'marketing',
      })
      .eq('id', args.contactId)
      .eq('account_id', args.accountId);
    if (error && !isMissingSchemaError(error)) {
      console.error('[campaigns] opt-out update failed:', error.message);
      return false;
    }
    return !error;
  } catch (err) {
    console.error('[campaigns] handleOptOutButton failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Keep the sender's WhatsApp profile name (shown as "WhatsApp Name" on
 * Customers) and record how a brand-new contact arrived. Source is only
 * written on creation — never overwrites an import/manual provenance.
 * Consent (opt_in_status) is deliberately untouched.
 */
export async function recordInboundProvenance(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    profileName?: string | null;
    wasCreated: boolean;
    fromAd: boolean;
  },
): Promise<void> {
  const name = args.profileName?.trim().slice(0, 200) || null;
  try {
    const patch: Record<string, string> = {};
    if (args.wasCreated) {
      patch.source = args.fromAd ? 'ctwa_ad' : 'whatsapp';
      if (name) patch.wa_profile_name = name;
    } else if (name) {
      const { data, error } = await db
        .from('contacts')
        .select('wa_profile_name')
        .eq('id', args.contactId)
        .maybeSingle();
      if (error) {
        if (!isMissingSchemaError(error)) console.error('[campaigns] profile lookup failed:', error.message);
        return;
      }
      if ((data as { wa_profile_name?: string | null } | null)?.wa_profile_name !== name) {
        patch.wa_profile_name = name;
      }
    }
    if (!Object.keys(patch).length) return;
    const { error } = await db
      .from('contacts')
      .update(patch)
      .eq('id', args.contactId)
      .eq('account_id', args.accountId);
    if (error && !isMissingSchemaError(error)) {
      console.error('[campaigns] provenance update failed:', error.message);
    }
  } catch (err) {
    console.error('[campaigns] recordInboundProvenance failed:', err instanceof Error ? err.message : err);
  }
}
