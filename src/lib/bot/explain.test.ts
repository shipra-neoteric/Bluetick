import { describe, expect, it } from 'vitest';
import { explainInbound, type ExplainInput } from './explain';

const base: ExplainInput = {
  text: 'hi',
  firstInbound: false,
  flows: [{ id: 'f1', name: 'Welcome menu', trigger_type: 'keyword', trigger_config: { keywords: ['hi'], match_type: 'word' } }],
  automations: [
    { id: 'a1', name: 'Hi auto-reply', trigger_type: 'keyword_match', trigger_config: { keywords: ['hi'], match_type: 'word' } },
    { id: 'a2', name: 'Daily hello', trigger_type: 'first_daily_message', trigger_config: {} },
  ],
  ai: { configured: true, autoReply: true },
};

describe('explainInbound', () => {
  it('flow wins a shared keyword; the automation is reported as skipped, not removed', () => {
    const r = explainInbound(base);
    expect(r.owner).toBe('flow');
    expect(r.lines).toContainEqual({ key: 'flowStarts', flow: 'Welcome menu' });
    expect(r.lines).toContainEqual({ key: 'automationsSkipped', names: 'Hi auto-reply' });
    expect(r.lines).toContainEqual({ key: 'lifecycleRuns', name: 'Daily hello', trigger: 'first_daily_message' });
    expect(r.lines).toContainEqual({ key: 'aiStandsDown', reason: 'flow' });
    expect(r.overlaps).toEqual([{ keyword: 'hi', winner: 'Welcome menu', loser: 'Hi auto-reply' }]);
  });

  it('an active run keeps the message unless a restart keyword matches', () => {
    expect(explainInbound({ ...base, text: 'price', activeFlowName: 'Lead form' }).lines[0]).toEqual({ key: 'flowActive', flow: 'Lead form' });
    const restart = {
      ...base,
      activeFlowName: 'Lead form',
      flows: [{ ...base.flows[0], trigger_config: { keywords: ['hi'], restart_policy: 'restart' } }],
    };
    expect(explainInbound(restart).lines[0]).toEqual({ key: 'flowRestart', flow: 'Welcome menu' });
  });

  it('AI stands down while any per-message automation responder is active', () => {
    const r = explainInbound({ ...base, text: 'is parking included?', flows: [] });
    expect(r.lines).toContainEqual({ key: 'aiStandsDown', reason: 'responder' });
    expect(r.owner).toBe('none');
  });

  it('no keyword match automation runs only when no keyword automation matched', () => {
    const r = explainInbound({
      ...base,
      text: 'parking?',
      flows: [],
      automations: [{ id: 'a3', name: 'Fallback', trigger_type: 'no_keyword_match', trigger_config: {} }],
    });
    expect(r.owner).toBe('automation');
    expect(r.lines).toContainEqual({ key: 'automationRuns', name: 'Fallback', trigger: 'no_keyword_match' });
  });

  it('AI answers when nothing else does and no human owns the chat', () => {
    expect(explainInbound({ ...base, text: 'parking?', flows: [], automations: [] }).owner).toBe('ai');
    expect(explainInbound({ ...base, text: 'parking?', flows: [], automations: [], humanAssigned: true }).owner).toBe('none');
  });
});
