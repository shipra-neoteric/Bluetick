/**
 * Capability handlers shared by the Flow runner and the Automation
 * engine. They only perform the action — run state, logging and branch
 * decisions stay in each engine, which keeps the two engines separate.
 *
 * Every function takes the service-role client and an explicit
 * accountId, and scopes every read/write to that account.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingSchemaError } from '@/lib/db/schema-compat';
import { DEFAULT_BUSINESS_HOURS, type BusinessHours } from './working-hours';
import type { VariableScope } from './variables';

// ── Assignment ────────────────────────────────────────────────────────

export type AssignMode = 'specific' | 'round_robin' | 'random' | 'last_agent';

export interface AssignInput {
  accountId: string;
  /** Preferred target. When absent, every conversation of the contact. */
  conversationId?: string | null;
  contactId?: string | null;
  mode: AssignMode;
  agentId?: string | null;
  pool?: string[] | null;
  /** Replace an existing assignee. */
  reassign: boolean;
  /** Round-robin cursor key (one rotation per automation / flow node). */
  poolKey: string;
}

export type AssignResult =
  | { status: 'assigned'; agentId: string }
  | { status: 'kept'; agentId: string }
  | { status: 'no_agent'; reason: string };

const ASSIGNABLE_ROLES = ['owner', 'admin', 'agent'];

async function eligibleAgents(db: SupabaseClient, accountId: string, pool: string[] | null | undefined): Promise<string[]> {
  let q = db.from('profiles').select('user_id').eq('account_id', accountId).in('account_role', ASSIGNABLE_ROLES);
  if (pool?.length) q = q.in('user_id', pool);
  const { data } = await q;
  return ((data ?? []) as { user_id: string }[]).map((r) => r.user_id).sort();
}

export async function pickAgent(
  db: SupabaseClient,
  input: Pick<AssignInput, 'accountId' | 'mode' | 'agentId' | 'pool' | 'poolKey'> & { conversationIds?: string[] },
  random: () => number = Math.random,
): Promise<string | null> {
  if (input.mode === 'last_agent') {
    // The human who last replied in this customer's chats, if they are
    // still an assignable member. Otherwise rotate over the pool.
    if (input.conversationIds?.length) {
      const { data } = await db
        .from('messages')
        .select('sender_id')
        .in('conversation_id', input.conversationIds)
        .eq('sender_type', 'agent')
        .not('sender_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1);
      const last = ((data ?? [])[0] as { sender_id?: string } | undefined)?.sender_id;
      if (last) {
        const ok = await eligibleAgents(db, input.accountId, [last]);
        if (ok.includes(last)) return last;
      }
    }
    return pickAgent(db, { ...input, mode: 'round_robin' }, random);
  }
  if (input.mode === 'specific') {
    if (!input.agentId) return null;
    const ok = await eligibleAgents(db, input.accountId, [input.agentId]);
    return ok[0] ?? null;
  }
  if (input.mode === 'random') {
    const pool = await eligibleAgents(db, input.accountId, input.pool);
    return pool.length ? pool[Math.floor(random() * pool.length)] : null;
  }
  // Round-robin: atomic cursor in the database (migration 047).
  const { data, error } = await db.rpc('next_round_robin_agent', {
    p_account: input.accountId,
    p_pool_key: input.poolKey,
    p_pool: input.pool?.length ? input.pool : [],
  });
  if (error) {
    if (!isMissingSchemaError(error)) throw new Error(`round-robin failed: ${error.message}`);
    // Pre-047 database: no cursor table. Fall back to the first eligible
    // agent (the engine's previous behaviour) rather than failing.
    const pool = await eligibleAgents(db, input.accountId, input.pool);
    return pool[0] ?? null;
  }
  return (data as string | null) ?? null;
}

export async function assignConversation(
  db: SupabaseClient,
  input: AssignInput,
  random?: () => number,
): Promise<AssignResult> {
  // Respect an existing owner unless reassign is on.
  const target = db.from('conversations').select('id, assigned_agent_id').eq('account_id', input.accountId);
  const { data: convs } = input.conversationId
    ? await target.eq('id', input.conversationId)
    : await target.eq('contact_id', input.contactId ?? '');
  const rows = (convs ?? []) as { id: string; assigned_agent_id: string | null }[];
  if (!rows.length) return { status: 'no_agent', reason: 'no conversation' };
  const current = rows.find((r) => r.assigned_agent_id)?.assigned_agent_id ?? null;
  if (current && !input.reassign) return { status: 'kept', agentId: current };

  const agentId = await pickAgent(db, { ...input, conversationIds: rows.map((r) => r.id) }, random);
  if (!agentId) return { status: 'no_agent', reason: 'no eligible agent' };

  let upd = db
    .from('conversations')
    .update({ assigned_agent_id: agentId, updated_at: new Date().toISOString() })
    .eq('account_id', input.accountId)
    .in('id', rows.map((r) => r.id));
  // Compare-and-set: without reassign, only claim still-unassigned chats.
  if (!input.reassign) upd = upd.is('assigned_agent_id', null);
  const { data: changed, error } = await upd.select('id');
  if (error) throw new Error(`assignment failed: ${error.message}`);
  if (!changed?.length && !input.reassign) {
    const { data: now } = await db.from('conversations').select('assigned_agent_id').in('id', rows.map((r) => r.id)).limit(1);
    const owner = ((now ?? [])[0] as { assigned_agent_id?: string | null } | undefined)?.assigned_agent_id;
    if (owner) return { status: 'kept', agentId: owner };
  }
  return { status: 'assigned', agentId };
}

// ── Consent ───────────────────────────────────────────────────────────

/**
 * Marketing opt-out (same fields as the template opt-out button). It is
 * NOT a CRM block: support messages and the inbox keep working; marketing
 * broadcasts, scheduled sends and Marketing-category automation
 * templates skip the contact.
 */
export async function optOutContact(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; source: string },
): Promise<'opted_out' | 'already' | 'unsupported'> {
  const { data, error } = await db
    .from('contacts')
    .select('opt_in_status')
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return 'unsupported';
    throw new Error(error.message);
  }
  if ((data as { opt_in_status?: string } | null)?.opt_in_status === 'opted_out') return 'already';
  const { error: updErr } = await db
    .from('contacts')
    .update({
      opt_in_status: 'opted_out',
      opt_out_at: new Date().toISOString(),
      opt_in_source: args.source.slice(0, 200),
      opt_in_scope: 'marketing',
    })
    .eq('id', args.contactId)
    .eq('account_id', args.accountId);
  if (updErr) throw new Error(updErr.message);
  return 'opted_out';
}

// ── Contact attributes ────────────────────────────────────────────────

export const BUILT_IN_FIELDS = ['name', 'email', 'company'] as const;

/**
 * Set or clear one attribute. `custom:<id>` writes contact_custom_values
 * (the field definition itself is never touched). No-op writes are
 * skipped, so field-change triggers only fire on real changes.
 */
export async function setContactField(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; field: string; value: string | null },
): Promise<'updated' | 'unchanged' | 'not_writable'> {
  if (args.field.startsWith('custom:')) {
    const fieldId = args.field.slice(7);
    if (!fieldId) return 'not_writable';
    const { data: def } = await db
      .from('custom_fields')
      .select('id')
      .eq('id', fieldId)
      .eq('account_id', args.accountId)
      .maybeSingle();
    if (!def) return 'not_writable';
    const { data: cur } = await db
      .from('contact_custom_values')
      .select('value')
      .eq('contact_id', args.contactId)
      .eq('custom_field_id', fieldId)
      .maybeSingle();
    const before = (cur as { value?: string | null } | null)?.value ?? null;
    if (before === args.value) return 'unchanged';
    if (args.value === null) {
      await db.from('contact_custom_values').delete().eq('contact_id', args.contactId).eq('custom_field_id', fieldId);
    } else {
      await db
        .from('contact_custom_values')
        .upsert({ contact_id: args.contactId, custom_field_id: fieldId, value: args.value }, { onConflict: 'contact_id,custom_field_id' });
    }
    return 'updated';
  }
  if (!(BUILT_IN_FIELDS as readonly string[]).includes(args.field)) return 'not_writable';
  const { data: row } = await db
    .from('contacts')
    .select(args.field)
    .eq('id', args.contactId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  if (!row) return 'not_writable';
  if (((row as unknown as Record<string, unknown>)[args.field] ?? null) === args.value) return 'unchanged';
  await db
    .from('contacts')
    .update({ [args.field]: args.value, updated_at: new Date().toISOString() })
    .eq('id', args.contactId)
    .eq('account_id', args.accountId);
  return 'updated';
}

// ── Context loaders ───────────────────────────────────────────────────

export async function loadBusinessHours(db: SupabaseClient, accountId: string): Promise<BusinessHours> {
  const { data, error } = await db
    .from('business_hours')
    .select('timezone, schedule, holidays')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !data) return DEFAULT_BUSINESS_HOURS;
  const row = data as BusinessHours;
  return {
    timezone: row.timezone || DEFAULT_BUSINESS_HOURS.timezone,
    schedule: row.schedule ?? {},
    holidays: Array.isArray(row.holidays) ? row.holidays : [],
  };
}

/** Contact + custom values for {{contact.*}} tokens. */
export async function loadContactScope(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  withCustom: boolean,
): Promise<Pick<VariableScope, 'contact' | 'custom'>> {
  const { data: c } = await db
    .from('contacts')
    .select('name, phone, email, company')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  const custom: Record<string, string> = {};
  if (withCustom) {
    const { data: vals } = await db.from('contact_custom_values').select('custom_field_id, value').eq('contact_id', contactId);
    for (const v of (vals ?? []) as { custom_field_id: string; value: string | null }[]) {
      if (v.value != null) custom[v.custom_field_id] = v.value;
    }
  }
  return { contact: (c as VariableScope['contact']) ?? {}, custom };
}
