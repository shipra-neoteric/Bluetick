import { describe, expect, it } from 'vitest';
import { simulateFlow, type SimNode } from './simulate';

const nodes: SimNode[] = [
  { node_key: 'start', node_type: 'start', config: { next_node_key: 'hours' } },
  { node_key: 'hours', node_type: 'working_hours', config: { open_next: 'menu', closed_next: 'closed' } },
  { node_key: 'closed', node_type: 'send_message', config: { text: 'We are closed, {{contact.name}}.', next_node_key: 'end' } },
  {
    node_key: 'menu',
    node_type: 'send_buttons',
    config: {
      text: 'Which project?',
      buttons: [
        { reply_id: 'gc', title: 'Garden City', next_node_key: 'budget' },
        { reply_id: 'np', title: 'Nature Park', next_node_key: 'agent' },
      ],
    },
  },
  { node_key: 'budget', node_type: 'collect_input', config: { prompt_text: 'Budget?', var_key: 'budget', enforce_validation: true, validation: 'number', next_node_key: 'fmt' } },
  { node_key: 'fmt', node_type: 'format_value', config: { kind: 'phone', input: '{{contact.phone}}', output_var: 'ph', default_country_code: '91', next_node_key: 'agent' } },
  { node_key: 'agent', node_type: 'handoff', config: {} },
  { node_key: 'end', node_type: 'end', config: {} },
];
const flow = { trigger_type: 'keyword' as const, trigger_config: { keywords: ['hi'], match_type: 'word' }, entry_node_id: 'start' };
const open = new Date('2026-10-19T05:00:00Z'); // Monday 10:30 IST
const ctx = { now: open, contact: { name: 'Asha', phone: '9876543210' }, tagIds: [], custom: {} };

describe('simulateFlow', () => {
  it('starts on the keyword and waits at the menu', () => {
    const r = simulateFlow(flow, nodes, [{ kind: 'text', text: 'hi there' }], ctx);
    expect(r.status).toBe('waiting');
    expect(r.waitingAt).toBe('menu');
    expect(r.steps.find((s) => s.kind === 'prompt')?.options?.map((o) => o.reply_id)).toEqual(['gc', 'np']);
  });

  it('routes by reply id, validates answers and formats values', () => {
    const r = simulateFlow(flow, nodes, [
      { kind: 'text', text: 'hi' },
      { kind: 'tap', reply_id: 'gc', title: 'Garden City' },
      { kind: 'text', text: 'about 80 lakh' }, // not a number → reprompt
      { kind: 'text', text: '80,00,000' },
    ], ctx);
    expect(r.steps.filter((s) => s.kind === 'fallback').map((s) => s.detail)).toEqual(['reprompt']);
    expect(r.vars).toEqual({ budget: '80,00,000', ph: '+919876543210' });
    expect(r.status).toBe('handed_off');
  });

  it('uses the fake clock for working hours and contact variables', () => {
    const night = { ...ctx, now: new Date('2026-10-19T17:00:00Z') };
    const r = simulateFlow(flow, nodes, [{ kind: 'text', text: 'hi' }], night);
    expect(r.steps.find((s) => s.kind === 'message')?.detail).toBe('We are closed, Asha.');
    expect(r.status).toBe('completed');
  });

  it('a label typed as text is not a tap; fallback exhausts to handoff', () => {
    const r = simulateFlow(flow, nodes, [
      { kind: 'text', text: 'hi' },
      { kind: 'text', text: 'Garden City' },
      { kind: 'text', text: 'Garden City' },
      { kind: 'text', text: 'Garden City' },
    ], ctx);
    expect(r.steps.filter((s) => s.kind === 'fallback').map((s) => s.detail)).toEqual(['reprompt', 'reprompt', 'handoff']);
    expect(r.status).toBe('handed_off');
  });

  it('does not start when the keyword does not match', () => {
    expect(simulateFlow(flow, nodes, [{ kind: 'text', text: 'this' }], ctx).status).toBe('not_started');
  });
});
