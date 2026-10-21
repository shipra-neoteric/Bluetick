import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { UNKNOWN, columnValue, fetchAllCustomers, fetchCustomerPage, type CustomerRow } from './customers';

const labels = { yes: 'Yes', no: 'No' };

function row(over: Partial<CustomerRow> = {}, contact: Record<string, unknown> = {}): CustomerRow {
  return {
    contact: { id: 'c1', user_id: 'u', name: 'Sample One', phone: '+919000000001', created_at: '2026-10-01T06:30:00Z', ...contact } as CustomerRow['contact'],
    conversation_id: null, ticket_status: null, ticket_opened_at: null, ticket_closed_at: null, ticket_replied: null,
    first_message_received_at: null, first_message_sent_at: null, last_message_sent_at: null, last_template_sent_at: null,
    tagNames: [], customValues: {}, ...over,
  };
}

describe('customer columns', () => {
  it('shows unknown, never a fake value, when data is missing', () => {
    const r = row();
    for (const c of ['email', 'waName', 'tags', 'firstReceived', 'ticketStatus', 'ticketReplied', 'lastCtwa', 'cf:x']) {
      expect(columnValue(r, c, labels)).toBe(UNKNOWN);
    }
    // blocked_at absent (pre-044) is unknown; null means "not blocked".
    expect(columnValue(r, 'blocked', labels)).toBe(UNKNOWN);
    expect(columnValue(row({}, { blocked_at: null }), 'blocked', labels)).toBe('No');
  });

  it('formats real values in IST', () => {
    const r = row({ tagNames: ['Garden City', 'Hot'], customValues: { f1: 'Site visit' }, ticket_replied: true });
    expect(columnValue(r, 'tags', labels)).toBe('Garden City, Hot');
    expect(columnValue(r, 'cf:f1', labels)).toBe('Site visit');
    expect(columnValue(r, 'ticketReplied', labels)).toBe('Yes');
    expect(columnValue(r, 'createdAt', labels)).toMatch(/1 Oct 2026.*12:00/);
  });
});

/** Fake db: rpc returns `pages` in order (or an error), side tables empty. */
function fakeDb(rpc: { data?: unknown[][]; error?: { code: string; message: string } }, contacts: unknown[] = []) {
  let call = 0;
  const calls: string[] = [];
  const chain = (result: unknown) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'or', 'order', 'in']) b[m] = () => b;
    b.range = () => Promise.resolve(result);
    b.then = (res: (r: unknown) => unknown) => Promise.resolve(result).then(res);
    return b;
  };
  const db = {
    rpc: () => {
      calls.push('rpc');
      if (rpc.error) return Promise.resolve({ data: null, error: rpc.error });
      return Promise.resolve({ data: rpc.data?.[call++] ?? [], error: null });
    },
    from: (table: string) => {
      calls.push(table);
      return chain(table === 'contacts' ? { data: contacts, count: contacts.length, error: null } : { data: [], error: null });
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const rpcRow = (id: string, total: number) => ({ ...row({}, { id }), total_count: total });

describe('fetchCustomerPage', () => {
  it('uses the RPC and its total', async () => {
    const { db } = fakeDb({ data: [[rpcRow('a', 2), rpcRow('b', 2)]] });
    const page = await fetchCustomerPage(db, { tagId: null, search: '', sort: 'created_desc', limit: 50, offset: 0 });
    expect(page).toMatchObject({ total: 2, mode: 'full' });
    expect(page.rows.map((r) => r.contact.id)).toEqual(['a', 'b']);
  });

  it('falls back to a basic contacts query before migration 046', async () => {
    const { db, calls } = fakeDb({ error: { code: 'PGRST202', message: 'function not found' } }, [{ id: 'z', phone: '+1', created_at: '2026-01-01T00:00:00Z' }]);
    const page = await fetchCustomerPage(db, { tagId: null, search: '', sort: 'created_desc', limit: 50, offset: 0 });
    expect(page.mode).toBe('basic');
    expect(page.rows[0].last_message_sent_at).toBeNull();
    expect(calls).toContain('contacts');
  });

  it('export pages through every result', async () => {
    const first = Array.from({ length: 200 }, (_, i) => rpcRow(`p1-${i}`, 250));
    const second = Array.from({ length: 50 }, (_, i) => rpcRow(`p2-${i}`, 250));
    const { db } = fakeDb({ data: [first, second] });
    const all = await fetchAllCustomers(db, { tagId: 't', search: '', sort: 'created_desc' });
    expect(all).toHaveLength(250);
  });
});
