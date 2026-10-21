import { describe, expect, it } from 'vitest';
import { activeNavHref } from './sidebar';

describe('activeNavHref', () => {
  it('lights up only the most specific entry', () => {
    expect(activeNavHref('/broadcasts/scheduled')).toBe('/broadcasts/scheduled');
    expect(activeNavHref('/broadcasts')).toBe('/broadcasts');
    expect(activeNavHref('/broadcasts/0f3a')).toBe('/broadcasts');
    expect(activeNavHref('/broadcasts/new')).toBe('/broadcasts');
  });

  it('keeps every pre-existing route reachable', () => {
    for (const href of ['/dashboard', '/inbox', '/notifications', '/contacts', '/pipelines', '/flows', '/agents']) {
      expect(activeNavHref(href)).toBe(href);
    }
  });

  it('keeps Automations reachable under Flows (one Flow)', () => {
    expect(activeNavHref('/automations')).toBe('/flows');
    expect(activeNavHref('/automations/abc/edit')).toBe('/flows');
  });

  it('does not match on a shared prefix', () => {
    expect(activeNavHref('/adsomething')).toBeNull();
    expect(activeNavHref('/settings')).toBeNull();
  });
});
