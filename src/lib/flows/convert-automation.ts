/**
 * Automation → Flow conversion (migration 048, "one Flow").
 *
 * Pure: takes an automation and its step rows, returns the equivalent
 * flow. Behaviour is kept, not approximated:
 *   - every action step becomes an `action` node run by the SAME
 *     executor Automations use (so buttons sent by an automation still
 *     don't wait for a reply, round-robin still rotates, etc.);
 *   - wait → Time Delay, wait_until → Wait Till;
 *   - condition → a Flow condition carrying the automation rule, with
 *     each branch continuing into the steps after the condition (the
 *     automation's own continuation semantics);
 *   - keyword_match → the flow "keyword" trigger with the same config.
 * The last step simply has nothing after it, which ends the flow.
 */

import type { FlowTriggerKind } from "./types";

export interface AutomationForConversion {
  id: string;
  name: string;
  description?: string | null;
  trigger_type: string;
  trigger_config: Record<string, unknown> | null;
  is_active: boolean;
}

export interface StepRowForConversion {
  id: string;
  step_type: string;
  step_config: Record<string, unknown> | null;
  position: number;
  parent_step_id?: string | null;
  branch?: "yes" | "no" | null;
}

export interface ConvertedNode {
  node_key: string;
  node_type: "action" | "time_delay" | "wait_until" | "condition";
  config: Record<string, unknown>;
}

export interface ConvertedFlow {
  name: string;
  description: string | null;
  trigger_type: FlowTriggerKind;
  trigger_config: Record<string, unknown>;
  entry_node_id: string | null;
  nodes: ConvertedNode[];
  /** Things the user should know (shown after converting). */
  notes: string[];
}

export function convertAutomationToFlow(
  automation: AutomationForConversion,
  steps: StepRowForConversion[],
): ConvertedFlow {
  const nodes: ConvertedNode[] = [];
  const notes: string[] = [];
  let n = 0;
  const key = () => `step_${++n}`;

  const scope = (parent: string | null, branch: "yes" | "no" | null) =>
    steps
      .filter((s) =>
        parent === null
          ? !s.parent_step_id
          : s.parent_step_id === parent && (s.branch ?? "yes") === (branch ?? "yes"),
      )
      .sort((a, b) => a.position - b.position);

  // Builds one scope back to front so each step knows its successor.
  // Returns the scope's first node key (or `after` when it is empty).
  const build = (parent: string | null, branch: "yes" | "no" | null, after: string | null): string | null => {
    const list = scope(parent, branch);
    // Keys are assigned front to back so they read in order on screen.
    const keys = list.map(() => key());
    let next = after;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      const cfg = s.step_config ?? {};
      const k = keys[i];
      if (s.step_type === "condition") {
        const yes = build(s.id, "yes", next);
        const no = build(s.id, "no", next);
        nodes.push({
          node_key: k,
          node_type: "condition",
          config: {
            subject: "var",
            subject_key: "",
            operator: "present",
            rule: { subject: cfg.subject, operand: cfg.operand, value: cfg.value },
            true_next: yes ?? "",
            false_next: no ?? "",
          },
        });
      } else if (s.step_type === "wait") {
        nodes.push({
          node_key: k,
          node_type: "time_delay",
          config: { amount: Number(cfg.amount) || 1, unit: cfg.unit ?? "minutes", next_node_key: next ?? "" },
        });
      } else if (s.step_type === "wait_until") {
        nodes.push({ node_key: k, node_type: "wait_until", config: { ...cfg, next_node_key: next ?? "" } });
      } else {
        nodes.push({
          node_key: k,
          node_type: "action",
          config: { step_type: s.step_type, step_config: cfg, next_node_key: next ?? "" },
        });
      }
      next = k;
    }
    return next;
  };

  const entry = build(null, null, null);
  if (!entry) notes.push("This automation had no steps, so the flow is empty.");

  let trigger_type = automation.trigger_type as FlowTriggerKind;
  const trigger_config = { ...(automation.trigger_config ?? {}) };
  if (automation.trigger_type === "keyword_match") {
    trigger_type = "keyword";
    notes.push(
      "Keyword trigger: like other flows, it only starts when the customer isn't already in another flow, and only the first matching flow runs.",
    );
  }
  if (automation.trigger_type === "time_based") {
    notes.push("Scheduled triggers weren't running for automations either; this flow won't start by itself.");
  }

  // Sorted for a stable, readable order (dagre lays them out on open).
  nodes.sort((a, b) => Number(a.node_key.slice(5)) - Number(b.node_key.slice(5)));

  return {
    name: automation.name,
    description: automation.description ?? null,
    trigger_type,
    trigger_config,
    entry_node_id: entry,
    nodes,
    notes,
  };
}
