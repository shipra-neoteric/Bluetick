import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { answerIsValid, matchesKeywordTrigger } from '@/lib/flows/engine';
import { autoOnlyCycleNodes, validateFlowForActivation } from '@/lib/flows/validate';
import { deriveCanvasEdges, outgoingSlots, applyEdgeConnection, unlinkNodeReferences } from '@/lib/flows/edges';
import { triggerMatches } from '@/lib/automations/engine';
import { assignConversation } from './actions';
import { dedupeKey, sanitizeSample, samplePaths, valueAtPath, hashToken } from './inbound-webhook';
import type { Automation } from '@/types';
import type { BuilderNode } from '@/components/flows/shared';

describe('collect_input validation (opt-in)', () => {
  it('checks email / phone / number / regex', () => {
    expect(answerIsValid('asha@example.com', { validation: 'email' })).toBe(true);
    expect(answerIsValid('asha@', { validation: 'email' })).toBe(false);
    expect(answerIsValid('+91 98765 43210', { validation: 'phone' })).toBe(true);
    expect(answerIsValid('call me', { validation: 'phone' })).toBe(false);
    expect(answerIsValid('80,00,000', { validation: 'number' })).toBe(true);
    expect(answerIsValid('eighty lakh', { validation: 'number' })).toBe(false);
    expect(answerIsValid('8000000', { validation: 'number' })).toBe(true);
    expect(answerIsValid('2BHK', { validation: 'regex', regex: '^[1-5]BHK$' })).toBe(true);
    expect(answerIsValid('6BHK', { validation: 'regex', regex: '^[1-5]BHK$' })).toBe(false);
    expect(answerIsValid('x', { validation: 'regex', regex: '(' })).toBe(false); // broken pattern fails closed
  });
});

describe('flow keyword matching', () => {
  it('adds whole-word matching without changing contains/exact', () => {
    expect(matchesKeywordTrigger('thanks', { keywords: ['k'], match_type: 'contains' })).toBe(true);
    expect(matchesKeywordTrigger('thanks', { keywords: ['k'], match_type: 'word' })).toBe(false);
    expect(matchesKeywordTrigger('ok k', { keywords: ['k'], match_type: 'word' })).toBe(true);
    expect(matchesKeywordTrigger('Hi', { keywords: ['hi'], match_type: 'exact' })).toBe(true);
  });
});

const node = (node_key: string, node_type: string, config: Record<string, unknown>) =>
  ({ node_key, node_type, config }) as BuilderNode;

describe('Bot Studio nodes in the graph', () => {
  const nodes = [
    node('start', 'start', { next_node_key: 'hours' }),
    node('hours', 'working_hours', { open_next: 'assign', closed_next: 'loc', holiday_next: '' }),
    node('assign', 'assign_agent', { mode: 'round_robin', next_node_key: 'end' }),
    node('loc', 'send_location', { latitude: '18.52', longitude: '73.85', next_node_key: 'end' }),
    node('end', 'end', {}),
  ];

  it('derives labelled edges and slots from the registry', () => {
    const edges = deriveCanvasEdges(nodes);
    expect(edges.filter((e) => e.source === 'hours').map((e) => e.sourceHandle)).toEqual(['open', 'closed']);
    expect(outgoingSlots(nodes[1]).map((s) => s.id)).toEqual(['open', 'closed', 'holiday']);
    expect(applyEdgeConnection(nodes[1], 'holiday', 'end')).toEqual({ holiday_next: 'end' });
    const unlinked = unlinkNodeReferences(nodes, 'end');
    expect(unlinked.find((n) => n.node_key === 'assign')?.config.next_node_key).toBe('');
  });

  it('validates required fields and targets', () => {
    const ok = validateFlowForActivation(
      { name: 'demo', trigger_type: 'keyword', trigger_config: { keywords: ['hi'] }, entry_node_id: 'start' },
      nodes,
    );
    expect(ok.filter((i) => i.severity === 'error')).toEqual([]);
    const bad = validateFlowForActivation(
      { name: 'demo', trigger_type: 'keyword', trigger_config: { keywords: ['hi'] }, entry_node_id: 'start' },
      [
        node('start', 'start', { next_node_key: 'loc' }),
        node('loc', 'send_location', { latitude: '123', longitude: '73', next_node_key: 'gone' }),
      ],
    );
    expect(bad.map((i) => i.field)).toEqual(expect.arrayContaining(['latitude', 'next_node_key']));
  });

  it('blocks loops that never wait for the customer, allows re-ask menus', () => {
    expect(autoOnlyCycleNodes([
      node('a', 'set_field', { next_node_key: 'b' }),
      node('b', 'assign_agent', { next_node_key: 'a' }),
    ]).sort()).toEqual(['a', 'b']);
    expect(autoOnlyCycleNodes([
      node('menu', 'send_buttons', { buttons: [{ reply_id: 'again', next_node_key: 'tag' }] }),
      node('tag', 'set_tag', { next_node_key: 'menu' }),
    ])).toEqual([]);
  });

  it('keeps an unknown node type visible but blocks activation', () => {
    const issues = validateFlowForActivation(
      { name: 'x', trigger_type: 'manual', trigger_config: {}, entry_node_id: 'start' },
      [node('start', 'start', { next_node_key: 'future' }), node('future', 'from_a_newer_version', {})],
    );
    expect(issues.some((i) => i.node_key === 'future' && i.severity === 'error')).toBe(true);
  });
});

const auto = (trigger_type: string, trigger_config: Record<string, unknown>) =>
  ({ trigger_type, trigger_config }) as unknown as Automation;

describe('automation trigger filters', () => {
  it('filters optional fields; empty = any', () => {
    expect(triggerMatches(auto('contact_field_changed', {}), { field: 'email' })).toBe(true);
    expect(triggerMatches(auto('contact_field_changed', { field: 'custom:f1' }), { field: 'email' })).toBe(false);
    expect(triggerMatches(auto('ctwa_message', { source_ids: ['AD1'] }), { source_id: 'AD1' })).toBe(true);
    expect(triggerMatches(auto('ctwa_message', { source_ids: ['AD1'] }), { source_id: 'AD2' })).toBe(false);
    expect(triggerMatches(auto('template_delivered', { template_names: [] }), { template_name: 'promo' })).toBe(true);
    expect(triggerMatches(auto('conversation_assigned', { agent_id: 'u1' }), { agent_id: 'u2' })).toBe(false);
  });

  it('Lead From CTWA: new contacts by default, new ads when enabled, ad filter', () => {
    const lead = (new_contact: boolean, new_ad: boolean, source_id = 'AD1') => ({ source_id, trigger: { new_contact, new_ad } });
    expect(triggerMatches(auto('ctwa_lead', {}), lead(true, false))).toBe(true);
    expect(triggerMatches(auto('ctwa_lead', {}), lead(false, true))).toBe(false);
    expect(triggerMatches(auto('ctwa_lead', { lead_mode: 'new_ad' }), lead(false, true))).toBe(true);
    expect(triggerMatches(auto('ctwa_lead', { lead_mode: 'new_ad' }), lead(false, false))).toBe(false);
    expect(triggerMatches(auto('ctwa_lead', { source_ids: ['AD2'] }), lead(true, false))).toBe(false);
    expect(triggerMatches(auto('ctwa_lead', { source_ids: ['AD1'] }), lead(true, false))).toBe(true);
  });

  it('attribute change modes (T09.02): set first time / removed / any', () => {
    const ev = (old_value: string | null, new_value: string | null) => ({ field: 'email', trigger: { old_value, new_value } });
    const first = auto('contact_field_changed', { change_mode: 'first_set' });
    expect(triggerMatches(first, ev(null, 'a@x.test'))).toBe(true);
    expect(triggerMatches(first, ev('a@x.test', 'b@x.test'))).toBe(false);
    const removed = auto('contact_field_changed', { change_mode: 'removed' });
    expect(triggerMatches(removed, ev('a@x.test', ''))).toBe(true);
    expect(triggerMatches(removed, ev(null, 'a@x.test'))).toBe(false);
    expect(triggerMatches(auto('contact_field_changed', {}), ev('a', 'b'))).toBe(true);
  });
});

/** Fake db for assignConversation: one conversation, two agents. */
function assignDb(current: string | null, rpcAgent: string | null, lastSender: string | null = null) {
  const updates: unknown[] = [];
  const db = {
    rpc: async () => ({ data: rpcAgent, error: null }),
    from(table: string) {
      const b: Record<string, unknown> = {};
      let isUpdate = false;
      for (const m of ['select', 'eq', 'in', 'is', 'limit', 'not', 'order']) b[m] = () => b;
      b.update = (p: unknown) => { isUpdate = true; updates.push(p); return b; };
      b.then = (res: (r: unknown) => unknown) => {
        if (table === 'conversations' && !isUpdate) return Promise.resolve({ data: [{ id: 'c1', assigned_agent_id: current }], error: null }).then(res);
        if (table === 'conversations' && isUpdate) return Promise.resolve({ data: [{ id: 'c1' }], error: null }).then(res);
        if (table === 'profiles') return Promise.resolve({ data: [{ user_id: 'a1' }, { user_id: 'b1' }], error: null }).then(res);
        if (table === 'messages') return Promise.resolve({ data: lastSender ? [{ sender_id: lastSender }] : [], error: null }).then(res);
        return Promise.resolve({ data: null, error: null }).then(res);
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, updates };
}

describe('assignment', () => {
  const base = { accountId: 'acc', conversationId: 'c1', poolKey: 'k' };
  it('keeps an existing assignee unless reassign is on', async () => {
    const { db, updates } = assignDb('x9', 'a1');
    expect(await assignConversation(db, { ...base, mode: 'round_robin', reassign: false })).toEqual({ status: 'kept', agentId: 'x9' });
    expect(updates).toHaveLength(0);
    expect(await assignConversation(db, { ...base, mode: 'round_robin', reassign: true })).toEqual({ status: 'assigned', agentId: 'a1' });
  });
  it('reports when nobody is eligible', async () => {
    const { db } = assignDb(null, null);
    expect(await assignConversation(db, { ...base, mode: 'round_robin', reassign: false })).toMatchObject({ status: 'no_agent' });
  });
  it('last human agent (A15.04) gets the chat back; otherwise round-robin', async () => {
    const withLast = assignDb(null, 'a1', 'b1');
    expect(await assignConversation(withLast.db, { ...base, mode: 'last_agent', reassign: true })).toEqual({ status: 'assigned', agentId: 'b1' });
    const noLast = assignDb(null, 'a1', null);
    expect(await assignConversation(noLast.db, { ...base, mode: 'last_agent', reassign: true })).toEqual({ status: 'assigned', agentId: 'a1' });
  });
  it('random picks from the eligible pool', async () => {
    const { db } = assignDb(null, null);
    expect(await assignConversation(db, { ...base, mode: 'random', reassign: false }, () => 0.99)).toEqual({ status: 'assigned', agentId: 'b1' });
  });
});

describe('inbound webhook helpers', () => {
  const body = { lead: { phone: '9876543210', name: 'Asha', api_key: 'sk-123' }, items: [1] };
  it('reads mapped paths without prototype access', () => {
    expect(valueAtPath(body, 'lead.phone')).toBe('9876543210');
    expect(valueAtPath(body, 'lead.__proto__')).toBeUndefined();
  });
  it('masks secrets in captured samples and lists leaf paths', () => {
    const s = sanitizeSample(body) as { lead: Record<string, unknown> };
    expect(s.lead.api_key).toBe('••••');
    expect(samplePaths(body)).toEqual(['lead.phone', 'lead.name', 'lead.api_key', 'items']);
  });
  it('dedupes by idempotency header, else body hash', () => {
    expect(dedupeKey(new Headers({ 'Idempotency-Key': 'abc' }), '{}')).toBe('h:abc');
    expect(dedupeKey(new Headers(), '{"a":1}')).toBe(dedupeKey(new Headers(), '{"a":1}'));
    expect(hashToken('t')).toHaveLength(64);
  });
});
