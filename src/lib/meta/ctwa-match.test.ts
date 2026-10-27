import { describe, expect, it } from 'vitest';
import { ctwaAdMatches, lookupIsFresh, LOOKUP_TTL_MS, MISS_TTL_MS, parseAdLookup, trackOf } from './ctwa-match';
import { triggerMatches } from '@/lib/automations/engine';
import type { Automation } from '@/types';

const ad = { campaign_id: 'c1', adset_id: 's1' };

describe('trackOf', () => {
  it('defaults to all', () => {
    expect(trackOf(undefined)).toBe('all');
    expect(trackOf({ track: 'bogus' })).toBe('all');
    expect(trackOf({ track: 'adset' })).toBe('adset');
  });
});

describe('ctwaAdMatches', () => {
  it('all = any ad, even unresolved', () => {
    expect(ctwaAdMatches({}, '123', {})).toBe(true);
    expect(ctwaAdMatches({ track: 'all' }, null, undefined)).toBe(true);
  });
  it('campaign needs the resolved campaign id', () => {
    expect(ctwaAdMatches({ track: 'campaign', campaign_id: 'c1' }, '123', ad)).toBe(true);
    expect(ctwaAdMatches({ track: 'campaign', campaign_id: 'c2' }, '123', ad)).toBe(false);
    expect(ctwaAdMatches({ track: 'campaign', campaign_id: 'c1' }, '123', {})).toBe(false);
    expect(ctwaAdMatches({ track: 'campaign' }, '123', ad)).toBe(false);
  });
  it('ad set needs the resolved ad set id', () => {
    expect(ctwaAdMatches({ track: 'adset', adset_id: 's1' }, '123', ad)).toBe(true);
    expect(ctwaAdMatches({ track: 'adset', adset_id: 's9' }, '123', ad)).toBe(false);
  });
  it('legacy source_ids still filter', () => {
    expect(ctwaAdMatches({ source_ids: ['123'] }, '123', {})).toBe(true);
    expect(ctwaAdMatches({ source_ids: ['999'] }, '123', {})).toBe(false);
    expect(ctwaAdMatches({ source_ids: ['999'], track: 'campaign', campaign_id: 'c1' }, '123', ad)).toBe(false);
    expect(ctwaAdMatches({ source_ids: [''] }, '123', {})).toBe(true);
  });
});

describe('parseAdLookup', () => {
  it('reads the Graph ad fields', () => {
    expect(
      parseAdLookup({ id: '1', name: 'Ad A', adset: { id: 's1', name: 'Set' }, campaign: { id: 'c1', name: 'OBC Basic 29 may' } }),
    ).toEqual({ ad_name: 'Ad A', adset_id: 's1', adset_name: 'Set', campaign_id: 'c1', campaign_name: 'OBC Basic 29 may' });
  });
  it('tolerates missing / odd fields', () => {
    expect(parseAdLookup(null)).toEqual({ ad_name: null, adset_id: null, adset_name: null, campaign_id: null, campaign_name: null });
    expect(parseAdLookup({ campaign: { id: 5 } }).campaign_id).toBeNull();
  });
});

describe('lookupIsFresh', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it('keeps found ads for a week, misses for an hour', () => {
    expect(lookupIsFresh({ campaign_id: 'c1', fetched_at: ago(LOOKUP_TTL_MS - 1000) }, now)).toBe(true);
    expect(lookupIsFresh({ campaign_id: 'c1', fetched_at: ago(LOOKUP_TTL_MS + 1000) }, now)).toBe(false);
    expect(lookupIsFresh({ campaign_id: null, fetched_at: ago(MISS_TTL_MS - 1000) }, now)).toBe(true);
    expect(lookupIsFresh({ campaign_id: null, fetched_at: ago(MISS_TTL_MS + 1000) }, now)).toBe(false);
    expect(lookupIsFresh({ campaign_id: 'c1', fetched_at: 'garbage' }, now)).toBe(false);
  });
});

describe('triggerMatches ctwa_lead', () => {
  const rule = (trigger_config: Record<string, unknown>, trigger_type = 'ctwa_lead') =>
    ({ trigger_type, trigger_config }) as unknown as Automation;
  const lead = (extra: Record<string, unknown> = {}) => ({ source_id: '123', trigger: { new_contact: true, new_ad: false, ...ad, ...extra } });

  it('new contact from any ad by default', () => {
    expect(triggerMatches(rule({ track: 'all' }), lead())).toBe(true);
    expect(triggerMatches(rule({}), lead({ new_contact: false, new_ad: true }))).toBe(false);
  });
  it('legacy lead_mode new_ad still counts known contacts', () => {
    expect(triggerMatches(rule({ lead_mode: 'new_ad' }), lead({ new_contact: false, new_ad: true }))).toBe(true);
  });
  it('follows the picked campaign / ad set', () => {
    expect(triggerMatches(rule({ track: 'campaign', campaign_id: 'c1' }), lead())).toBe(true);
    expect(triggerMatches(rule({ track: 'campaign', campaign_id: 'c2' }), lead())).toBe(false);
    expect(triggerMatches(rule({ track: 'adset', adset_id: 's1' }), lead())).toBe(true);
    expect(triggerMatches(rule({ track: 'adset', adset_id: 's1' }), lead({ adset_id: null }))).toBe(false);
  });
  it('ctwa_message uses the same ad filter', () => {
    expect(triggerMatches(rule({ track: 'campaign', campaign_id: 'c1' }, 'ctwa_message'), lead())).toBe(true);
    expect(triggerMatches(rule({ track: 'campaign', campaign_id: 'c9' }, 'ctwa_message'), lead())).toBe(false);
    expect(triggerMatches(rule({ source_ids: [] }, 'ctwa_message'), lead())).toBe(true);
  });
});
