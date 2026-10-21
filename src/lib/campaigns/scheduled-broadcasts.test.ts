import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const deliverBroadcast = vi.fn(async () => {});
const finalizeBroadcastStatus = vi.fn(async () => {});
const planBroadcastResume = vi.fn();
const releaseBroadcastDelivery = vi.fn(async () => {});
const claimBroadcastDelivery = vi.fn(async () => true);

vi.mock('@/lib/whatsapp/broadcast-core', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/broadcast-core')>()),
  deliverBroadcast: (...a: unknown[]) => deliverBroadcast(...(a as [])),
  finalizeBroadcastStatus: (...a: unknown[]) => finalizeBroadcastStatus(...(a as [])),
}));
vi.mock('@/lib/whatsapp/broadcast-resume', () => ({
  DELIVERY_LOCK_STALE_MS: 30 * 60 * 1000,
  planBroadcastResume: (...a: unknown[]) => planBroadcastResume(...a),
  releaseBroadcastDelivery: (...a: unknown[]) => releaseBroadcastDelivery(...(a as [])),
  claimBroadcastDelivery: (...a: unknown[]) => claimBroadcastDelivery(...(a as [])),
}));

import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import { runScheduledBroadcasts, templateGate } from './scheduled-broadcasts';

interface Update { table: string; payload: unknown }

/** One claimable broadcast; template status configurable. */
function fakeDb(opts: { templateStatus: string | null; claimError?: { code: string; message: string } }) {
  const updates: Update[] = [];
  let claims = 0;
  const db = {
    rpc() {
      claims++;
      if (opts.claimError) return Promise.resolve({ data: null, error: opts.claimError });
      return Promise.resolve({
        data: claims === 1 ? [{ broadcast_id: 'b1', account_id: 'acc' }] : [],
        error: null,
      });
    },
    from(table: string) {
      let payload: unknown;
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'not', 'or', 'order']) b[m] = () => b;
      b.update = (p: unknown) => { payload = p; return b; };
      const result = () => {
        if (payload !== undefined) {
          updates.push({ table, payload });
          return { data: null, error: null };
        }
        if (table === 'broadcasts') return { data: { template_name: 'promo', template_language: 'en' }, error: null };
        if (table === 'message_templates') return { data: opts.templateStatus ? [{ status: opts.templateStatus }] : [], error: null };
        return { data: [], error: null };
      };
      b.maybeSingle = () => Promise.resolve(result());
      // limit() on broadcasts = the continuation scan; none pending here.
      b.limit = () => Promise.resolve(table === 'broadcasts' ? { data: [], error: null } : result());
      b.then = (res: (r: unknown) => unknown) => Promise.resolve(result()).then(res);
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, updates };
}

const far = () => Date.now() + 60_000;

beforeEach(() => {
  vi.clearAllMocks();
  planBroadcastResume.mockResolvedValue({ plan: { broadcastId: 'b1', planned: [] }, remaining: 0, unsendable: 0 });
});

describe('templateGate', () => {
  it('sends only approved templates', () => {
    expect(templateGate('APPROVED')).toBe('ok');
    expect(templateGate('PENDING')).toBe('hold');
    expect(templateGate('PAUSED')).toBe('hold');
    expect(templateGate('REJECTED')).toBe('reject');
    expect(templateGate(null)).toBe('reject');
  });
});

describe('runScheduledBroadcasts', () => {
  it('delivers a due broadcast through the resume engine and releases the lock', async () => {
    const { db } = fakeDb({ templateStatus: 'APPROVED' });
    const { outcomes } = await runScheduledBroadcasts(db, far());
    expect(outcomes).toEqual([{ broadcastId: 'b1', result: 'delivered' }]);
    expect(planBroadcastResume).toHaveBeenCalledWith(db, 'acc', 'b1', 'pending');
    expect(deliverBroadcast).toHaveBeenCalledTimes(1);
    expect(releaseBroadcastDelivery).toHaveBeenCalledWith(db, 'b1');
  });

  it('holds (re-queues) when the template is still pending — nothing is sent', async () => {
    const { db, updates } = fakeDb({ templateStatus: 'PENDING' });
    const { outcomes } = await runScheduledBroadcasts(db, far());
    expect(outcomes[0]).toMatchObject({ result: 'held' });
    expect(deliverBroadcast).not.toHaveBeenCalled();
    expect(updates.find((u) => u.table === 'broadcasts')?.payload).toMatchObject({
      status: 'scheduled', hold_reason: 'template_not_approved',
    });
  });

  it('fails without sending when the template was rejected', async () => {
    const { db, updates } = fakeDb({ templateStatus: 'REJECTED' });
    const { outcomes } = await runScheduledBroadcasts(db, far());
    expect(outcomes[0]).toMatchObject({ result: 'failed', detail: 'template_rejected' });
    expect(deliverBroadcast).not.toHaveBeenCalled();
    expect(updates.map((u) => u.table)).toEqual(['broadcast_recipients', 'broadcasts']);
  });

  it('settles a broadcast whose recipients were all suppressed', async () => {
    planBroadcastResume.mockRejectedValue(new BroadcastError('nothing_to_resume', 'none', 400));
    const { db } = fakeDb({ templateStatus: 'APPROVED' });
    const { outcomes } = await runScheduledBroadcasts(db, far());
    expect(outcomes[0]).toMatchObject({ result: 'empty' });
    expect(finalizeBroadcastStatus).toHaveBeenCalledWith(db, 'b1');
  });

  it('reports an un-migrated database instead of failing', async () => {
    const { db } = fakeDb({ templateStatus: 'APPROVED', claimError: { code: 'PGRST202', message: 'not found' } });
    expect(await runScheduledBroadcasts(db, far())).toEqual({ outcomes: [], notMigrated: true });
  });

  it('starts no work after the deadline', async () => {
    const { db } = fakeDb({ templateStatus: 'APPROVED' });
    const { outcomes } = await runScheduledBroadcasts(db, Date.now() - 1);
    expect(outcomes).toEqual([]);
    expect(deliverBroadcast).not.toHaveBeenCalled();
  });
});
