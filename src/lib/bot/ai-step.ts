/**
 * Explicit, scoped AI step for Flows ("Generate AI response").
 *
 * Reuses the AI Agents configuration (provider, model, key, system
 * prompt, knowledge base). It differs from global auto-reply only in
 * WHERE it runs: the flow author placed it, the flow owns the inbound,
 * so the webhook never also runs auto-reply for that message. It does
 * not need auto-reply to be switched on, does not consume the per-chat
 * auto-reply budget, and never assigns or disables anything by itself —
 * a handoff answer just takes the node's handoff branch.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAiConfig } from '@/lib/ai/config';
import { buildConversationContext } from '@/lib/ai/context';
import { retrieveKnowledge } from '@/lib/ai/knowledge';
import { generateReply } from '@/lib/ai/generate';
import { buildSystemPrompt } from '@/lib/ai/defaults';
import { logAiUsage } from '@/lib/ai/usage';
import { latestUserMessage } from '@/lib/ai/query';

export type AiStepResult =
  | { ok: true; text: string; handoff: boolean }
  | { ok: false; reason: 'not_configured' | 'no_context' | 'error'; detail?: string };

export async function runAiStep(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; instruction?: string },
): Promise<AiStepResult> {
  try {
    const config = await loadAiConfig(db, args.accountId);
    if (!config) return { ok: false, reason: 'not_configured' };
    const messages = await buildConversationContext(db, args.conversationId);
    if (!messages.length) return { ok: false, reason: 'no_context' };
    const knowledge = await retrieveKnowledge(db, args.accountId, config, latestUserMessage(messages));
    const base = buildSystemPrompt({ userPrompt: config.systemPrompt, mode: 'auto_reply', knowledge });
    const systemPrompt = args.instruction?.trim()
      ? `${base}\n\nAdditional instruction for this step: ${args.instruction.trim().slice(0, 1000)}`
      : base;
    const { text, handoff, usage } = await generateReply({ config, systemPrompt, messages });
    void logAiUsage(db, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      mode: 'flow',
      provider: config.provider,
      model: config.model,
      usage,
    });
    return { ok: true, text: text ?? '', handoff: handoff || !text };
  } catch (err) {
    return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}
