import { describe, expect, it } from 'vitest';
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components';
import { buildSendComponents } from '@/lib/whatsapp/template-send-builder';
import { validateButtons } from '@/lib/whatsapp/template-validators';
import type { MessageTemplate, TemplateButton } from '@/types';
import { preserveOptOutFlags } from './template-flags';

const flow: TemplateButton = { type: 'FLOW', text: 'Book a visit', flow_id: '1234567890', navigate_screen: 'WELCOME' };

describe('FLOW template buttons', () => {
  it('submits flow_id and navigate_screen to Meta', () => {
    const p = buildMetaTemplatePayload({
      name: 'visit', category: 'Marketing', language: 'en', body_text: 'Hi', buttons: [flow],
    });
    const buttons = p.components.find((c) => c.type === 'BUTTONS');
    expect(buttons?.buttons).toEqual([
      { type: 'FLOW', text: 'Book a visit', flow_id: '1234567890', navigate_screen: 'WELCOME' },
    ]);
  });

  it('requires a numeric flow id and allows only one FLOW button', () => {
    expect(() => validateButtons([flow])).not.toThrow();
    expect(() => validateButtons([{ ...flow, flow_id: '' }])).toThrow(/Flow ID/);
    expect(() => validateButtons([{ ...flow, flow_id: 'abc' }])).toThrow(/Flow ID/);
    expect(() => validateButtons([flow, { ...flow, text: 'Again' }])).toThrow(/FLOW/);
  });

  it('sends no button component by default, and a flow_token when given', () => {
    const tpl: MessageTemplate = {
      id: 't', user_id: 'u', name: 'visit', category: 'Marketing', language: 'en',
      body_text: 'Hi', created_at: '2026-01-01T00:00:00Z', buttons: [flow],
    };
    expect(buildSendComponents(tpl)).toEqual([]);
    expect(buildSendComponents(tpl, { buttonParams: { 0: 'tok-1' } })).toEqual([
      { type: 'button', sub_type: 'flow', index: '0', parameters: [{ type: 'action', action: { flow_token: 'tok-1' } }] },
    ]);
  });
});

describe('marketing opt-out quick reply', () => {
  it('is sent to Meta as a plain quick reply (flag stays local)', () => {
    const p = buildMetaTemplatePayload({
      name: 'promo', category: 'Marketing', language: 'en', body_text: 'Offer',
      buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions', opt_out: true }],
    });
    expect(p.components.find((c) => c.type === 'BUTTONS')?.buttons).toEqual([
      { type: 'QUICK_REPLY', text: 'Stop promotions' },
    ]);
  });

  it('allows at most one opt-out button', () => {
    expect(() => validateButtons([
      { type: 'QUICK_REPLY', text: 'Stop', opt_out: true },
      { type: 'QUICK_REPLY', text: 'Unsubscribe', opt_out: true },
    ])).toThrow(/opt-out/);
  });

  it('survives a template sync from Meta', () => {
    const fresh: TemplateButton[] = [
      { type: 'QUICK_REPLY', text: 'Interested' },
      { type: 'QUICK_REPLY', text: 'Stop promotions' },
    ];
    const previous: TemplateButton[] = [
      { type: 'QUICK_REPLY', text: 'Interested' },
      { type: 'QUICK_REPLY', text: 'stop promotions ', opt_out: true },
    ];
    expect(preserveOptOutFlags(fresh, previous)).toEqual([
      { type: 'QUICK_REPLY', text: 'Interested' },
      { type: 'QUICK_REPLY', text: 'Stop promotions', opt_out: true },
    ]);
    expect(preserveOptOutFlags(null, previous)).toBeNull();
    expect(preserveOptOutFlags(fresh, null)).toBe(fresh);
  });
});
