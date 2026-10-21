/**
 * "Who answers this message?" — a dry run of the inbound pipeline order
 * (webhook route): 1) Flows, 2) Automations, 3) AI auto-reply. It
 * explains the existing precedence; it never changes it. Pure.
 */

import { matchesKeywordTrigger } from '@/lib/flows/matching';
import { matchesWholeWord } from './keyword';

export interface ExplainFlow {
  id: string;
  name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
}

export interface ExplainAutomation {
  id: string;
  name: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
}

export interface ExplainInput {
  text: string;
  firstInbound: boolean;
  /** Name of the flow the customer is currently inside, if any. */
  activeFlowName?: string | null;
  humanAssigned?: boolean;
  flows: ExplainFlow[]; // active, oldest first (the runner's order)
  automations: ExplainAutomation[]; // active
  ai: { configured: boolean; autoReply: boolean };
}

export type ExplainLine =
  | { key: 'flowActive'; flow: string }
  | { key: 'flowRestart'; flow: string }
  | { key: 'flowStarts'; flow: string }
  | { key: 'noFlow' }
  | { key: 'automationsSkipped'; names: string }
  | { key: 'automationRuns'; name: string; trigger: string }
  | { key: 'lifecycleRuns'; name: string; trigger: string }
  | { key: 'aiReplies' }
  | { key: 'aiStandsDown'; reason: 'flow' | 'responder' | 'off' | 'human' | 'not_text' };

export interface ExplainResult {
  owner: 'flow' | 'automation' | 'ai' | 'none';
  lines: ExplainLine[];
  /** Keyword overlaps worth knowing about (who wins, never a fix). */
  overlaps: { keyword: string; winner: string; loser: string }[];
}

const RESPONDERS = new Set(['new_message_received', 'keyword_match', 'no_keyword_match']);

function automationKeywordMatch(a: ExplainAutomation, text: string): boolean {
  const cfg = a.trigger_config as { keywords?: string[]; match_type?: string; case_sensitive?: boolean };
  if (!cfg.keywords?.length || !text) return false;
  if (cfg.match_type === 'word') return cfg.keywords.some((k) => matchesWholeWord(text, k, cfg.case_sensitive));
  const hay = cfg.case_sensitive ? text : text.toLowerCase();
  return cfg.keywords.some((k) => {
    const n = cfg.case_sensitive ? k : k.toLowerCase();
    return cfg.match_type === 'exact' ? hay === n : hay.includes(n);
  });
}

export function explainInbound(input: ExplainInput): ExplainResult {
  const lines: ExplainLine[] = [];
  const text = input.text.trim();
  let flowOwns = false;

  // 1. Flows
  const keywordFlows = input.flows.filter((f) => f.trigger_type === 'keyword');
  const restart = keywordFlows.find(
    (f) => (f.trigger_config as { restart_policy?: string }).restart_policy === 'restart' &&
      matchesKeywordTrigger(text, f.trigger_config as never),
  );
  if (input.activeFlowName && !restart) {
    lines.push({ key: 'flowActive', flow: input.activeFlowName });
    flowOwns = true;
  } else if (input.activeFlowName && restart) {
    lines.push({ key: 'flowRestart', flow: restart.name });
    flowOwns = true;
  } else {
    const starter = input.flows.find((f) =>
      f.trigger_type === 'keyword'
        ? matchesKeywordTrigger(text, f.trigger_config as never)
        : f.trigger_type === 'first_inbound_message' && input.firstInbound,
    );
    if (starter) {
      lines.push({ key: 'flowStarts', flow: starter.name });
      flowOwns = true;
    } else {
      lines.push({ key: 'noFlow' });
    }
  }

  // 2. Automations
  const contentTriggers = input.automations.filter((a) => RESPONDERS.has(a.trigger_type));
  let automationReplies = false;
  if (flowOwns) {
    const skipped = contentTriggers
      .filter((a) => a.trigger_type !== 'keyword_match' || automationKeywordMatch(a, text))
      .map((a) => a.name);
    if (skipped.length) lines.push({ key: 'automationsSkipped', names: skipped.join(', ') });
  } else {
    let keywordHits = 0;
    for (const a of contentTriggers) {
      if (a.trigger_type === 'new_message_received') {
        lines.push({ key: 'automationRuns', name: a.name, trigger: a.trigger_type });
        automationReplies = true;
      } else if (a.trigger_type === 'keyword_match' && automationKeywordMatch(a, text)) {
        lines.push({ key: 'automationRuns', name: a.name, trigger: a.trigger_type });
        keywordHits++;
        automationReplies = true;
      }
    }
    if (keywordHits === 0 && text) {
      for (const a of contentTriggers.filter((x) => x.trigger_type === 'no_keyword_match')) {
        lines.push({ key: 'automationRuns', name: a.name, trigger: a.trigger_type });
        automationReplies = true;
      }
    }
  }
  // Lifecycle triggers fire regardless of who owns the message.
  for (const a of input.automations) {
    if (a.trigger_type === 'first_inbound_message' && input.firstInbound) lines.push({ key: 'lifecycleRuns', name: a.name, trigger: a.trigger_type });
    if (a.trigger_type === 'first_daily_message') lines.push({ key: 'lifecycleRuns', name: a.name, trigger: a.trigger_type });
  }

  // 3. AI auto-reply (same gates as lib/ai/auto-reply)
  let aiReplies = false;
  if (flowOwns) lines.push({ key: 'aiStandsDown', reason: 'flow' });
  else if (!text) lines.push({ key: 'aiStandsDown', reason: 'not_text' });
  else if (!input.ai.configured || !input.ai.autoReply) lines.push({ key: 'aiStandsDown', reason: 'off' });
  else if (contentTriggers.length > 0) lines.push({ key: 'aiStandsDown', reason: 'responder' });
  else if (input.humanAssigned) lines.push({ key: 'aiStandsDown', reason: 'human' });
  else {
    lines.push({ key: 'aiReplies' });
    aiReplies = true;
  }

  // Overlaps: the same keyword on a flow and a keyword automation, or on
  // two flows (oldest active flow wins).
  const overlaps: ExplainResult['overlaps'] = [];
  for (let i = 0; i < keywordFlows.length; i++) {
    const f = keywordFlows[i];
    for (const kw of (f.trigger_config as { keywords?: string[] }).keywords ?? []) {
      for (const a of input.automations.filter((x) => x.trigger_type === 'keyword_match')) {
        if (automationKeywordMatch(a, kw)) overlaps.push({ keyword: kw, winner: f.name, loser: a.name });
      }
      for (const g of keywordFlows.slice(i + 1)) {
        if (matchesKeywordTrigger(kw, g.trigger_config as never)) overlaps.push({ keyword: kw, winner: f.name, loser: g.name });
      }
    }
  }

  return {
    owner: flowOwns ? 'flow' : automationReplies ? 'automation' : aiReplies ? 'ai' : 'none',
    lines,
    overlaps,
  };
}
