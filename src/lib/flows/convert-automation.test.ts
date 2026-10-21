import { describe, expect, it } from "vitest";
import { convertAutomationToFlow, type StepRowForConversion } from "./convert-automation";
import { validateFlowForActivation } from "./validate";

const auto = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  name: "Welcome drip",
  description: "synthetic",
  trigger_type: "new_contact_created",
  trigger_config: {},
  is_active: true,
  ...over,
});
const step = (id: string, step_type: string, position: number, step_config: Record<string, unknown> = {}, parent_step_id: string | null = null, branch: "yes" | "no" | null = null): StepRowForConversion => ({
  id, step_type, position, step_config, parent_step_id, branch,
});
const byKey = (f: ReturnType<typeof convertAutomationToFlow>) => Object.fromEntries(f.nodes.map((n) => [n.node_key, n]));

describe("convertAutomationToFlow", () => {
  it("chains steps in order: actions run by the automation executor, waits become delays", () => {
    const f = convertAutomationToFlow(auto(), [
      step("s1", "send_message", 0, { text: "Hi" }),
      step("s2", "wait", 1, { amount: 2, unit: "days" }),
      step("s3", "send_template", 2, { template_name: "follow_up" }),
    ]);
    expect(f.trigger_type).toBe("new_contact_created");
    expect(f.entry_node_id).toBe("step_1");
    const n = byKey(f);
    expect(n.step_1).toEqual({ node_key: "step_1", node_type: "action", config: { step_type: "send_message", step_config: { text: "Hi" }, next_node_key: "step_2" } });
    expect(n.step_2).toMatchObject({ node_type: "time_delay", config: { amount: 2, unit: "days", next_node_key: "step_3" } });
    // Last step: nothing after it → the flow ends.
    expect(n.step_3.config.next_node_key).toBe("");
  });

  it("keeps condition branches and continues after them", () => {
    const f = convertAutomationToFlow(auto(), [
      step("c", "condition", 0, { subject: "tag_presence", operand: "vip" }),
      step("y", "add_tag", 0, { tag_id: "t1" }, "c", "yes"),
      step("after", "close_conversation", 1),
    ]);
    const n = byKey(f);
    const cond = n[f.entry_node_id!];
    expect(cond.node_type).toBe("condition");
    expect(cond.config.rule).toEqual({ subject: "tag_presence", operand: "vip", value: undefined });
    const yes = n[cond.config.true_next as string];
    expect(yes.config.step_type).toBe("add_tag");
    // Both the yes branch and the empty no branch reach the next step.
    const after = n[cond.config.false_next as string];
    expect(after.config.step_type).toBe("close_conversation");
    expect(yes.config.next_node_key).toBe(after.node_key);
  });

  it("maps keyword_match to the flow keyword trigger with the same config", () => {
    const f = convertAutomationToFlow(auto({ trigger_type: "keyword_match", trigger_config: { keywords: ["price"], match_type: "word" } }), [
      step("s1", "send_message", 0, { text: "Prices…" }),
    ]);
    expect(f.trigger_type).toBe("keyword");
    expect(f.trigger_config).toEqual({ keywords: ["price"], match_type: "word" });
    expect(f.notes.length).toBe(1);
  });

  it("wait_until keeps its settings", () => {
    const f = convertAutomationToFlow(auto(), [step("w", "wait_until", 0, { at: "{{contact.custom.visit}}", if_past: "skip" })]);
    expect(f.nodes[0]).toMatchObject({ node_type: "wait_until", config: { at: "{{contact.custom.visit}}", if_past: "skip", next_node_key: "" } });
  });

  it("handles an automation without steps", () => {
    const f = convertAutomationToFlow(auto(), []);
    expect(f.entry_node_id).toBeNull();
    expect(f.nodes).toEqual([]);
    expect(f.notes[0]).toMatch(/no steps/);
  });

  it("produces a flow the validator accepts", () => {
    const f = convertAutomationToFlow(auto({ trigger_type: "conversation_closed" }), [
      step("s1", "send_message", 0, { text: "Thanks for chatting" }),
      step("c", "condition", 1, { subject: "working_hours" }),
      step("y", "close_conversation", 0, {}, "c", "yes"),
      step("s2", "wait", 2, { amount: 1, unit: "hours" }),
    ]);
    const issues = validateFlowForActivation(
      { name: f.name, trigger_type: f.trigger_type, trigger_config: f.trigger_config, entry_node_id: f.entry_node_id } as Parameters<typeof validateFlowForActivation>[0],
      f.nodes as Parameters<typeof validateFlowForActivation>[1],
    );
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});
