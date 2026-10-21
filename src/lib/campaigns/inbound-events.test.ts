import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  REPLY_WINDOW_HOURS,
  attributeBroadcastReply,
  captureReferral,
  handleOptOutButton,
  isOptOutTap,
  pickWindowedRecipient,
  recordInboundProvenance,
} from './inbound-events';

type Result = { data?: unknown; error?: { code?: string; message: string } | null };
interface Call { table: string; op: string; payload?: unknown; filters: [string, unknown][] }

/**
 * Minimal chainable stand-in for the Supabase query builder. `respond`
 * decides each query's result from the table, operation and filters.
 */
function fakeDb(respond: (c: Call) => Result) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, op: 'select', filters: [] };
      const b: Record<string, unknown> = {};
      const chain = (name: string) => (...args: unknown[]) => {
        call.filters.push([name, args]);
        return b;
      };
      for (const m of ['eq', 'in', 'gte', 'order', 'limit', 'select']) b[m] = chain(m);
      b.update = (p: unknown) => { call.op = 'update'; call.payload = p; return b; };
      b.insert = (p: unknown) => { call.op = 'insert'; call.payload = p; return b; };
      b.maybeSingle = () => b;
      b.then = (res: (r: Result) => unknown, rej: (e: unknown) => unknown) => {
        calls.push(call);
        return Promise.resolve({ data: null, error: null, ...respond(call) }).then(res, rej);
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const now = new Date('2026-10-17T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();

describe('pickWindowedRecipient', () => {
  it('credits only the latest send inside the window', () => {
    const rows = [
      { id: 'old', sent_at: hoursAgo(REPLY_WINDOW_HOURS + 1), created_at: hoursAgo(80) },
      { id: 'a', sent_at: hoursAgo(10), created_at: hoursAgo(10) },
      { id: 'b', sent_at: hoursAgo(2), created_at: hoursAgo(3) },
    ];
    expect(pickWindowedRecipient(rows, now)?.id).toBe('b');
    expect(pickWindowedRecipient([rows[0]], now)).toBeNull();
  });
});

describe('attributeBroadcastReply', () => {
  it('prefers the quoted broadcast message (context)', async () => {
    const { db, calls } = fakeDb((c) =>
      c.op === 'select' ? { data: [{ id: 'rec-1', status: 'delivered' }] } : {},
    );
    const r = await attributeBroadcastReply(db, { accountId: 'acc', contactId: 'c1', contextWamid: 'wamid.X', now });
    expect(r).toBe('context');
    const upd = calls.find((c) => c.op === 'update');
    expect(upd?.payload).toMatchObject({ status: 'replied', reply_attribution: 'context' });
  });

  it('falls back to the 72h window and never credits older broadcasts', async () => {
    const { db, calls } = fakeDb((c) => {
      if (c.op !== 'select') return {};
      return { data: [{ id: 'rec-old', sent_at: hoursAgo(100), created_at: hoursAgo(100) }] };
    });
    expect(await attributeBroadcastReply(db, { accountId: 'acc', contactId: 'c1', now })).toBeNull();
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });

  it('works before migration 046 (no reply_attribution column)', async () => {
    let updates = 0;
    const { db, calls } = fakeDb((c) => {
      if (c.op === 'select') return { data: [{ id: 'r', sent_at: hoursAgo(1), created_at: hoursAgo(1) }] };
      updates++;
      return updates === 1 ? { error: { code: '42703', message: 'column does not exist' } } : {};
    });
    expect(await attributeBroadcastReply(db, { accountId: 'acc', contactId: 'c1', now })).toBe('window');
    const last = calls.filter((c) => c.op === 'update').pop();
    expect(last?.payload).not.toHaveProperty('reply_attribution');
    expect(last?.payload).toMatchObject({ status: 'replied' });
  });
});

describe('captureReferral', () => {
  const base = { accountId: 'acc', contactId: 'c1', conversationId: 'cv', waMessageId: 'wamid.1' };

  it('ignores messages without ad data', async () => {
    const { db, calls } = fakeDb(() => ({}));
    expect(await captureReferral(db, { ...base, referral: undefined })).toBe(false);
    expect(await captureReferral(db, { ...base, referral: { headline: 'x' } })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('stores the referral and stamps last_ctwa_at', async () => {
    const { db, calls } = fakeDb(() => ({}));
    expect(await captureReferral(db, { ...base, referral: { source_type: 'ad', source_id: 'AD-1' } })).toBe(true);
    expect(calls[0]).toMatchObject({ table: 'message_referrals', op: 'insert' });
    expect(calls[1]).toMatchObject({ table: 'contacts', op: 'update' });
  });

  it('treats a replayed webhook as already stored', async () => {
    const { db, calls } = fakeDb(() => ({ error: { code: '23505', message: 'dup' } }));
    expect(await captureReferral(db, { ...base, referral: { source_id: 'AD-1' } })).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('opt-out button', () => {
  const buttons = [
    { type: 'QUICK_REPLY' as const, text: 'Interested' },
    { type: 'QUICK_REPLY' as const, text: 'Stop promotions', opt_out: true },
  ];

  it('matches only the flagged button, by text or payload', () => {
    expect(isOptOutTap(buttons, { text: 'stop promotions' })).toBe(true);
    expect(isOptOutTap(buttons, { payload: 'Stop promotions' })).toBe(true);
    expect(isOptOutTap(buttons, { text: 'Interested' })).toBe(false);
    // A similar label on an unflagged template never opts out.
    expect(isOptOutTap([{ type: 'QUICK_REPLY', text: 'Stop promotions' }], { text: 'Stop promotions' })).toBe(false);
  });

  it('opts the contact out of marketing when the flagged button is tapped', async () => {
    const { db, calls } = fakeDb((c) => {
      if (c.table === 'messages') return { data: [{ template_name: 'promo' }] };
      if (c.table === 'message_templates') return { data: [{ buttons }] };
      return {};
    });
    const ok = await handleOptOutButton(db, {
      accountId: 'acc', contactId: 'c1', contextWamid: 'wamid.T', button: { text: 'Stop promotions' },
    });
    expect(ok).toBe(true);
    const upd = calls.find((c) => c.table === 'contacts');
    expect(upd?.payload).toMatchObject({ opt_in_status: 'opted_out', opt_in_scope: 'marketing' });
  });

  it('resolves the template through the broadcast when no message row exists', async () => {
    const { db } = fakeDb((c) => {
      if (c.table === 'messages') return { data: [] };
      if (c.table === 'broadcast_recipients') return { data: [{ broadcasts: { template_name: 'promo' } }] };
      if (c.table === 'message_templates') return { data: [{ buttons }] };
      return {};
    });
    expect(await handleOptOutButton(db, {
      accountId: 'acc', contactId: 'c1', contextWamid: 'wamid.B', button: { payload: 'Stop promotions' },
    })).toBe(true);
  });
});

describe('recordInboundProvenance', () => {
  it('sets source and profile name only for a new contact', async () => {
    const { db, calls } = fakeDb(() => ({}));
    await recordInboundProvenance(db, { accountId: 'acc', contactId: 'c1', profileName: ' Asha ', wasCreated: true, fromAd: true });
    expect(calls[0].payload).toEqual({ source: 'ctwa_ad', wa_profile_name: 'Asha' });
  });

  it('updates an existing contact only when the name changed', async () => {
    const same = fakeDb(() => ({ data: { wa_profile_name: 'Asha' } }));
    await recordInboundProvenance(same.db, { accountId: 'acc', contactId: 'c1', profileName: 'Asha', wasCreated: false, fromAd: false });
    expect(same.calls.filter((c) => c.op === 'update')).toHaveLength(0);

    const changed = fakeDb((c) => (c.op === 'select' ? { data: { wa_profile_name: 'Old' } } : {}));
    await recordInboundProvenance(changed.db, { accountId: 'acc', contactId: 'c1', profileName: 'Asha', wasCreated: false, fromAd: false });
    expect(changed.calls.find((c) => c.op === 'update')?.payload).toEqual({ wa_profile_name: 'Asha' });
  });
});
