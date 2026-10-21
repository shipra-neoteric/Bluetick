import { describe, expect, it, vi } from 'vitest';
import {
  MESSAGING_ACTION,
  costPerChat,
  fetchAdInsights,
  normalizeAdAccountId,
  parseInsights,
  summarizeReferrals,
} from './ads';

describe('costPerChat', () => {
  it('is null — not zero or infinity — without chats', () => {
    expect(costPerChat(500, 0)).toBeNull();
    expect(costPerChat(500, null)).toBeNull();
    expect(costPerChat(null, 5)).toBeNull();
    expect(costPerChat(500, 3)).toBe(166.67);
  });
});

describe('normalizeAdAccountId', () => {
  it('accepts act_ prefix or bare digits only', () => {
    expect(normalizeAdAccountId('act_1234567')).toBe('act_1234567');
    expect(normalizeAdAccountId(' 1234567 ')).toBe('act_1234567');
    expect(normalizeAdAccountId('act_12ab')).toBeNull();
  });
});

describe('summarizeReferrals', () => {
  it('counts distinct contacts as chats and keeps click totals', () => {
    const rows = [
      { contact_id: 'c1', source_type: 'ad', source_id: 'AD1', source_url: null, headline: null, created_at: '2026-10-01T00:00:00Z' },
      { contact_id: 'c1', source_type: 'ad', source_id: 'AD1', source_url: null, headline: 'Garden City', created_at: '2026-10-03T00:00:00Z' },
      { contact_id: 'c2', source_type: 'ad', source_id: 'AD1', source_url: null, headline: null, created_at: '2026-10-02T00:00:00Z' },
      { contact_id: 'c3', source_type: 'post', source_id: 'P9', source_url: 'https://fb.example/p9', headline: null, created_at: '2026-10-05T00:00:00Z' },
    ];
    expect(summarizeReferrals(rows)).toEqual([
      { sourceId: 'AD1', sourceType: 'ad', headline: 'Garden City', sourceUrl: null, chats: 2, clicks: 3, firstAt: '2026-10-01T00:00:00Z', lastAt: '2026-10-03T00:00:00Z' },
      { sourceId: 'P9', sourceType: 'post', headline: null, sourceUrl: 'https://fb.example/p9', chats: 1, clicks: 1, firstAt: '2026-10-05T00:00:00Z', lastAt: '2026-10-05T00:00:00Z' },
    ]);
  });
});

describe('insights', () => {
  it('reads messaging conversations from actions; unknown stays null', () => {
    const [a, b, c] = parseInsights([
      { ad_id: '1', spend: '900.50', impressions: '1000', clicks: '40', actions: [{ action_type: MESSAGING_ACTION, value: '9' }] },
      { ad_id: '2', spend: '100', actions: [{ action_type: 'link_click', value: '3' }] },
      { ad_id: '3', spend: '50' },
    ]);
    expect(a).toMatchObject({ spend: 900.5, conversations: 9, costPerConversation: 100.06 });
    expect(b).toMatchObject({ conversations: 0, costPerConversation: null });
    expect(c).toMatchObject({ conversations: null, costPerConversation: null, impressions: null });
  });

  it('only issues GET requests and follows paging', async () => {
    const doFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ ad_id: '1' }], paging: { next: 'https://graph.facebook.com/next' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ ad_id: '2' }] })));
    const rows = await fetchAdInsights({ adAccountId: 'act_1', accessToken: 'secret', since: '2026-10-01', until: '2026-10-17' }, doFetch);
    expect(rows.map((r) => r.adId)).toEqual(['1', '2']);
    for (const call of doFetch.mock.calls) {
      expect((call[1] as RequestInit).method ?? 'GET').toBe('GET');
      // token goes in the header, never the URL
      expect(String(call[0])).not.toContain('secret');
    }
  });

  it('surfaces Meta error messages', async () => {
    const doFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token' } }), { status: 400 }));
    await expect(fetchAdInsights({ adAccountId: 'act_1', accessToken: 'x', since: '2026-10-01', until: '2026-10-02' }, doFetch)).rejects.toThrow('Invalid OAuth');
  });
});
