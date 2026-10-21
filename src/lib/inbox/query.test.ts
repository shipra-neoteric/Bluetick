import { describe, expect, it } from 'vitest';
import type { Conversation } from '@/types';
import {
  applyGroupValue,
  compactFilters,
  filtersWithoutGroup,
  isGroupValueActive,
  filtersToParams,
  formatCount,
  paramsToFilters,
  rowMatchesQueue,
  type InboxFilters,
} from './query';

describe('inbox filter URL state', () => {
  it('round-trips every filter through the URL', () => {
    const f: InboxFilters = {
      queue: 'awaiting',
      scope: 'mine',
      assignee: 'u-2',
      owner: null,
      tag_ids: ['t1', 't2'],
      field_id: 'f1',
      field_value: 'Hot - 60 Days',
      date_from: '2026-10-01T00:00:00.000Z',
      date_to: '2026-10-12T00:00:00.000Z',
      search: 'garden',
    };
    const params = filtersToParams(f, { view: 'v1', sort: 'waiting_longest' });
    const back = paramsToFilters(new URLSearchParams(params.toString()));
    expect(back).toEqual({ filters: f, view: 'v1', sort: 'waiting_longest' });
  });

  it('keeps the default URL empty and ignores unknown queues', () => {
    expect(filtersToParams({ queue: 'open', scope: 'all' }).toString()).toBe('');
    expect(paramsToFilters(new URLSearchParams('q=bogus')).filters.queue).toBe('open');
  });
});

describe('compactFilters', () => {
  it('drops empty values and needs both field id and value', () => {
    expect(
      compactFilters({ queue: 'all', scope: 'all', tag_ids: [], search: '  ', field_id: 'f', field_value: '' }),
    ).toEqual({ queue: 'all', scope: 'all' });
    expect(compactFilters({ queue: 'all', scope: 'all', tag_ids: ['b', 'a'] }).tag_ids).toEqual(['a', 'b']);
  });
});

describe('rowMatchesQueue (realtime arrivals)', () => {
  const base = { id: 'c', user_id: 'u', contact_id: 'ct', status: 'open', unread_count: 0, created_at: '', updated_at: '' } as Conversation;
  it('mirrors the SQL queue semantics for row-local fields', () => {
    expect(rowMatchesQueue({ ...base, awaiting_reply_since: 'x' }, { queue: 'awaiting', scope: 'all' }, 'me')).toBe(true);
    expect(rowMatchesQueue({ ...base, status: 'closed', awaiting_reply_since: 'x' }, { queue: 'awaiting', scope: 'all' }, 'me')).toBe(false);
    expect(rowMatchesQueue({ ...base, assigned_agent_id: 'me' }, { queue: 'all', scope: 'mine' }, 'me')).toBe(true);
    expect(rowMatchesQueue(base, { queue: 'all', scope: 'mine' }, 'me')).toBe(false);
    expect(rowMatchesQueue({ ...base, my_unread_count: 2 }, { queue: 'unread', scope: 'all' }, 'me')).toBe(true);
  });
});

describe('formatCount', () => {
  it('abbreviates large counts like the reference', () => {
    expect(formatCount(1500)).toBe('1K+');
    expect(formatCount(42)).toBe('42');
    expect(formatCount(null)).toBe('…');
  });
});

describe('group tabs helpers', () => {
  const base: InboxFilters = { queue: 'open', scope: 'all', assignee: 'u1' };
  it('applies and clears owner / field groups without touching other filters', () => {
    const owned = applyGroupValue(base, 'owner', 'u9');
    expect(owned).toMatchObject({ owner: 'u9', assignee: 'u1', queue: 'open' });
    expect(isGroupValueActive(owned, 'owner', 'u9')).toBe(true);
    expect(applyGroupValue(owned, 'owner', null).owner).toBeNull();

    const hot = applyGroupValue(base, 'field-1', 'Hot - 60 Days');
    expect(hot).toMatchObject({ field_id: 'field-1', field_value: 'Hot - 60 Days' });
    expect(isGroupValueActive(hot, 'field-1', 'hot - 60 days')).toBe(true);
    expect(filtersWithoutGroup(hot, 'field-1').field_id).toBeNull();
  });
  it('round-trips the owner filter through the URL', () => {
    const f: InboxFilters = { queue: 'all', scope: 'all', owner: 'u9', tag_ids: [] };
    expect(paramsToFilters(filtersToParams(f)).filters.owner).toBe('u9');
  });
});
