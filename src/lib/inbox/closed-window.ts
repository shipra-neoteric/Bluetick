import type { MessageTemplate } from '@/types';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';

/**
 * "Send a message to customer in closed window" (migration 055).
 *
 * Outside WhatsApp's 24-hour window only a template may be sent. An admin
 * picks one approved template whose body has a single `{{1}}`, e.g.
 * "Hello, {{1}} Your chat support request is successfully registered."
 * The composer then shows the text around `{{1}}` and the agent types the
 * middle — it goes out as that template with the typed text as `{{1}}`.
 */

/** Whether a template can carry a free-text message as its only input. */
export function isClosedWindowTemplate(t: MessageTemplate): boolean {
  if (t.status && t.status !== 'APPROVED') return false;
  const vars = extractVariableIndices(t.body_text ?? '');
  if (vars.length !== 1 || vars[0] !== 1) return false;
  // Anything else the send would have to fill in rules it out.
  if (t.header_type === 'text' && extractVariableIndices(t.header_content ?? '').length > 0) return false;
  if (
    (t.header_type === 'image' || t.header_type === 'video' || t.header_type === 'document') &&
    !t.header_media_url
  ) {
    return false;
  }
  return !(t.buttons ?? []).some((b) => b.type === 'URL' && extractVariableIndices(b.url ?? '').length > 0);
}

/** The body split around `{{1}}`: what the agent's text sits between. */
export function splitClosedWindowBody(body: string): { before: string; after: string } {
  const i = body.indexOf('{{1}}');
  if (i < 0) return { before: body, after: '' };
  return { before: body.slice(0, i).trimEnd(), after: body.slice(i + 5).trimStart() };
}
