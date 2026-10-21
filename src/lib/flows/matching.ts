/**
 * Pure flow-runtime decisions (reply matching, keyword triggers, answer
 * validation, condition predicates). Used by the server runner and by
 * the browser simulator, so it must not import server-only modules.
 */

import { matchesWholeWord } from "@/lib/bot/keyword";
import type {
  CollectInputNodeConfig,
  ConditionNodeConfig,
  KeywordTriggerConfig,
  ParsedInbound,
  SendButtonsNodeConfig,
  SendListNodeConfig,
} from "./types";

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  if (matchType === "word") {
    return cfg.keywords.some((k) => Boolean(k) && matchesWholeWord(text, k, cfg.case_sensitive));
  }
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/**
 * The strings an inbound message offers to a flow's *entry* trigger.
 *
 * Typed text offers itself. A button / list tap offers two: the visible
 * title — what the customer would have typed had the button not been
 * there — and the stable reply_id, because the automation engine's
 * `interactive_reply` trigger routes on the id, so an author moving a
 * menu into a flow reaches for the same value.
 *
 * Matching the id does mean a keyword that happens to be a substring of
 * an id can fire (ids are author-controlled slugs, defaulting to
 * `btn_1`). That is the same substring semantic keyword triggers
 * already have for typed text, and the alternative — ignoring the id —
 * silently breaks the author who keyed on it.
 */
export function entryTriggerTexts(message: ParsedInbound): string[] {
  if (message.kind === "text") return [message.text];
  return [...new Set([message.reply_title, message.reply_id])].filter(
    (v): v is string => Boolean(v && v.trim()),
  );
}

/**
 * Validate a captured answer for collect_input nodes that opted into
 * enforcement. Pure — exported for tests.
 */
export function answerIsValid(
  value: string,
  cfg: Pick<CollectInputNodeConfig, "validation" | "regex">,
): boolean {
  const v = value.trim();
  switch (cfg.validation) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
    case "phone":
      return /^\+?[0-9][0-9\s().-]{6,18}[0-9]$/.test(v);
    case "number":
      // Digit grouping (1,000,000 or Indian 10,00,000) is accepted;
      // "." is the only decimal separator.
      return /^-?\d+(?:\.\d+)?$/.test(v.replace(/(?<=\d)[\s,](?=\d)/g, ""));
    case "regex": {
      if (!cfg.regex) return true;
      try {
        // Bounded: authors write the pattern, answers are capped at 1 KB.
        return new RegExp(cfg.regex, "u").test(v.slice(0, 1024));
      } catch {
        return false;
      }
    }
    default:
      return v.length > 0;
  }
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}
