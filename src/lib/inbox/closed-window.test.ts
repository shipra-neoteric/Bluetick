import { describe, expect, it } from 'vitest';
import type { MessageTemplate } from '@/types';
import { isClosedWindowTemplate, splitClosedWindowBody } from './closed-window';

const tpl = (over: Partial<MessageTemplate>): MessageTemplate =>
  ({
    id: 't',
    user_id: 'u',
    name: 'support',
    category: 'Utility',
    body_text: 'Hello, {{1}} Your chat support request is successfully registered.',
    status: 'APPROVED',
    sent_count: 0,
    delivered_count: 0,
    read_count: 0,
    replied_count: 0,
    failed_count: 0,
    ...over,
  }) as MessageTemplate;

describe('isClosedWindowTemplate', () => {
  it('accepts an approved template with a single {{1}}', () => {
    expect(isClosedWindowTemplate(tpl({}))).toBe(true);
  });
  it('rejects templates that are not approved', () => {
    expect(isClosedWindowTemplate(tpl({ status: 'PENDING' }))).toBe(false);
  });
  it('rejects no variable, two variables, or a variable other than {{1}}', () => {
    expect(isClosedWindowTemplate(tpl({ body_text: 'Hi there' }))).toBe(false);
    expect(isClosedWindowTemplate(tpl({ body_text: 'Hi {{1}}, {{2}}' }))).toBe(false);
    expect(isClosedWindowTemplate(tpl({ body_text: 'Hi {{2}}' }))).toBe(false);
  });
  it('rejects headers or buttons that need their own input', () => {
    expect(isClosedWindowTemplate(tpl({ header_type: 'text', header_content: 'Hi {{1}}' }))).toBe(false);
    expect(isClosedWindowTemplate(tpl({ header_type: 'image' }))).toBe(false);
    expect(isClosedWindowTemplate(tpl({ header_type: 'image', header_media_url: 'https://x/y.png' }))).toBe(true);
    expect(
      isClosedWindowTemplate(tpl({ buttons: [{ type: 'URL', text: 'Open', url: 'https://x/{{1}}' }] as MessageTemplate['buttons'] })),
    ).toBe(false);
  });
});

describe('splitClosedWindowBody', () => {
  it('splits around {{1}}', () => {
    expect(splitClosedWindowBody('Hello, {{1}} Your request is registered.')).toEqual({
      before: 'Hello,',
      after: 'Your request is registered.',
    });
  });
  it('handles {{1}} at either end', () => {
    expect(splitClosedWindowBody('{{1}}')).toEqual({ before: '', after: '' });
    expect(splitClosedWindowBody('Note: {{1}}')).toEqual({ before: 'Note:', after: '' });
  });
});
