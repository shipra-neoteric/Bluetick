import { beforeEach, describe, expect, it, vi } from 'vitest';

// Marketing consent on automation template sends (campaigns spec): an
// opted-out contact gets no marketing template; utility still goes out.

let contact: Record<string, unknown> = {};
let category = 'Marketing';
const sendTemplateMessage = vi.fn(async () => ({ messageId: 'wamid.X' }));

vi.mock('@/lib/contacts/send-contact', () => ({
  selectContactForSend: async () => ({ data: contact, error: null }),
}));
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: async () => ({ row: { name: 'promo', category, body_text: 'Hi' }, language: 'en', malformed: false }),
  templateContentText: () => 'Hi',
}));
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'token' }));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: (...a: unknown[]) => sendTemplateMessage(...(a as [])),
  sendTextMessage: vi.fn(),
  sendInteractiveMessage: vi.fn(),
}));
vi.mock('./admin-client', () => {
  // Any table read resolves to a WhatsApp config / an inserted message.
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'select', 'eq', 'insert', 'update', 'order', 'limit']) chain[m] = () => chain;
  chain.single = async () => ({ data: { id: 'row', phone_number_id: 'pn', access_token: 'enc' }, error: null });
  chain.maybeSingle = chain.single;
  chain.then = (res: (r: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res);
  return { supabaseAdmin: () => chain };
});

import { engineSendTemplate } from './meta-send';

const args = { accountId: 'acc', userId: 'u', conversationId: 'cv', contactId: 'c1', templateName: 'promo' };

beforeEach(() => {
  sendTemplateMessage.mockClear();
  contact = { id: 'c1', phone: '+919000000001', wa_user_id: null, blocked_at: null, opt_in_status: 'opted_out' };
});

describe('automation template sends and marketing opt-out', () => {
  it('refuses a marketing template to an opted-out contact, before calling Meta', async () => {
    category = 'Marketing';
    await expect(engineSendTemplate(args)).rejects.toThrow(/opted out of marketing/);
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('still sends a utility template to the same contact', async () => {
    category = 'Utility';
    await engineSendTemplate(args).catch(() => {});
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });
});
