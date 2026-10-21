import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { addMemberToList, composePhone } from './list-members';

describe('composePhone', () => {
  it('joins the picked country code with the local number', () => {
    expect(composePhone('+91', '98765 43210')).toBe('+919876543210');
    expect(composePhone('+91', '098765-43210')).toBe('+919876543210');
  });
  it('keeps a number that already has its own country code', () => {
    expect(composePhone('+91', '+971 50 123 4567')).toBe('+971501234567');
  });
  it('rejects junk', () => {
    expect(composePhone('+91', '')).toBeNull();
    expect(composePhone('+91', 'abc')).toBeNull();
  });
});

/** contacts lookup returns `existing`; insert returns a new row or `insertError`. */
function db(opts: { existing?: { id: string; phone: string }[]; insertError?: { code: string; message: string } }) {
  const inserts: unknown[] = [];
  const client = {
    from() {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.like = () => Promise.resolve({ data: opts.existing ?? [], error: null });
      b.insert = (row: unknown) => {
        inserts.push(row);
        return {
          select: () => ({
            single: () =>
              Promise.resolve(
                opts.insertError && inserts.length === 1
                  ? { data: null, error: opts.insertError }
                  : { data: { id: 'new-1', phone: '+919876543210' }, error: null },
              ),
          }),
        };
      };
      return b;
    },
  };
  return { client: client as unknown as SupabaseClient, inserts };
}

const args = { accountId: 'acc', userId: 'u1', tagId: 'tag-1', name: 'Asha', phone: '+919876543210' };

describe('addMemberToList', () => {
  it('creates a new contact (source manual) and tags it', async () => {
    const tag = vi.fn(async () => ({}));
    const { client, inserts } = db({});
    expect(await addMemberToList(client, args, tag)).toEqual({ ok: true, contactId: 'new-1', created: true, alreadyMember: false });
    expect(inserts[0]).toMatchObject({ source: 'manual', name: 'Asha', phone: '+919876543210' });
    expect(tag).toHaveBeenCalledWith('new-1', 'tag-1');
  });

  it('reuses an existing contact with the same number', async () => {
    const tag = vi.fn(async () => ({ reason: 'duplicate' }));
    const { client, inserts } = db({ existing: [{ id: 'c-9', phone: '+91 98765 43210' }] });
    expect(await addMemberToList(client, args, tag)).toEqual({ ok: true, contactId: 'c-9', created: false, alreadyMember: true });
    expect(inserts).toHaveLength(0);
  });

  it('retries without `source` on a pre-046 database', async () => {
    const { client, inserts } = db({ insertError: { code: '42703', message: 'column "source" does not exist' } });
    const r = await addMemberToList(client, args, async () => ({}));
    expect(r).toMatchObject({ ok: true, created: true });
    expect(inserts[1]).not.toHaveProperty('source');
  });

  it('refuses a number without a country code', async () => {
    const { client } = db({});
    expect(await addMemberToList(client, { ...args, phone: '9876543210' }, async () => ({}))).toEqual({ ok: false, error: 'invalid_phone' });
  });
});
