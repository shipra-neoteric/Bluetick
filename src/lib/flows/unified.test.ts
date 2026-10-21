import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Unified Flows (migration 048): event-started background runs,
// Time Delay / Wait Till parking + resume, Automation `action` nodes,
// rule conditions, and "a step with nothing after it ends the flow".
// Drives the real engine against a fake Supabase that records writes.
// ============================================================

type Filter = [string, unknown];
const h = vi.hoisted(() => ({
  state: {
    flows: [] as Record<string, unknown>[],
    nodes: [] as Record<string, unknown>[],
    conversations: [{ id: "cv-1" }] as Record<string, unknown>[],
    inserted: [] as { table: string; row: Record<string, unknown> }[],
    updates: [] as { table: string; payload: Record<string, unknown>; filters: Filter[] }[],
    events: [] as Record<string, unknown>[],
    insertedRun: null as Record<string, unknown> | null,
    /** Returned by claim_flow_resumes. */
    claimed: [] as Record<string, unknown>[],
    /** Error for the next `exclusive: true` update (slot already held). */
    holdError: null as { message: string; code?: string } | null,
  },
  runActionStep: vi.fn(),
  evaluateActionRule: vi.fn(),
}));

vi.mock("./admin-client", () => {
  function rows(table: string): unknown[] {
    if (table === "flows") return h.state.flows;
    if (table === "flow_nodes") return h.state.nodes;
    if (table === "conversations") return h.state.conversations;
    return [];
  }
  function builder(table: string) {
    let mode: "select" | "update" | "insert" = "select";
    let payload: Record<string, unknown> = {};
    const filters: Filter[] = [];
    const result = () => {
      if (mode === "update") {
        h.state.updates.push({ table, payload, filters: [...filters] });
        if (table === "flow_runs" && payload.exclusive === true && h.state.holdError) {
          const error = h.state.holdError;
          h.state.holdError = null;
          return { data: null, error, count: 0 };
        }
        return { data: [{ id: "run-1" }], error: null, count: 0 };
      }
      return { data: rows(table), error: null, count: 0 };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (k: string, v: unknown) => (filters.push([k, v]), b),
      in: () => b,
      is: () => b,
      gte: () => b,
      filter: () => b,
      order: () => b,
      limit: () => b,
      update: (p: Record<string, unknown>) => ((mode = "update"), (payload = p), b),
      insert: (row: Record<string, unknown>) => {
        mode = "insert";
        h.state.inserted.push({ table, row });
        if (table === "flow_run_events") h.state.events.push(row);
        if (table === "flow_runs") {
          h.state.insertedRun = { id: "run-1", vars: {}, reprompt_count: 0, ...row };
        }
        return b;
      },
      maybeSingle: async () => ({
        data: table === "flow_runs" ? h.state.insertedRun : (rows(table)[0] ?? null),
        error: null,
      }),
      single: async () => ({ data: rows(table)[0] ?? null, error: null }),
      then: (resolve: (r: unknown) => unknown) => resolve(result()),
    };
    return b;
  }
  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: (name: string) =>
        Promise.resolve(
          name === "claim_flow_resumes" ? { data: h.state.claimed, error: null } : { data: null, error: null },
        ),
    }),
  };
});

const sendText = vi.fn(async () => ({ whatsapp_message_id: "wamid.1" }));
const sendButtons = vi.fn(async () => ({ whatsapp_message_id: "wamid.3" }));
vi.mock("./meta-send", () => ({
  engineSendText: (...a: unknown[]) => (sendText as unknown as (...x: unknown[]) => unknown)(...a),
  engineSendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.2" })),
  engineSendInteractiveButtons: (...a: unknown[]) => (sendButtons as unknown as (...x: unknown[]) => unknown)(...a),
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: "wamid.4" })),
}));

// The Automation executor is tested on its own; here we only check the
// flow hands it the right step and carries on.
vi.mock("@/lib/automations/engine", () => ({
  runActionStep: h.runActionStep,
  evaluateActionRule: h.evaluateActionRule,
  triggerMatches: (a: { trigger_type: string; trigger_config: { tag_id?: string } }, ctx: { tag_id?: string }) =>
    a.trigger_type !== "tag_added" || a.trigger_config.tag_id === ctx.tag_id,
}));

import { resumeDueFlowRuns, startFlowsForEvent } from "./engine";

const flow = (over: Record<string, unknown> = {}) => ({
  id: "flow-1",
  account_id: "acct-1",
  user_id: "u-1",
  status: "active",
  trigger_type: "conversation_closed",
  trigger_config: {},
  entry_node_id: "a",
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});
const node = (node_key: string, node_type: string, config: Record<string, unknown>) => ({
  id: node_key,
  flow_id: "flow-1",
  node_key,
  node_type,
  config,
});
const runUpdates = () => h.state.updates.filter((u) => u.table === "flow_runs").map((u) => u.payload);
const ended = () => runUpdates().find((p) => p.ended_at);

function fire(triggerType = "conversation_closed", context: Record<string, unknown> = {}) {
  return startFlowsForEvent({ accountId: "acct-1", triggerType, contactId: "ct-1", context });
}

beforeEach(() => {
  h.state.flows = [flow()];
  h.state.nodes = [];
  h.state.conversations = [{ id: "cv-1" }];
  h.state.inserted = [];
  h.state.updates = [];
  h.state.events = [];
  h.state.insertedRun = null;
  h.state.claimed = [];
  h.state.holdError = null;
  h.runActionStep.mockReset();
  h.runActionStep.mockResolvedValue({ detail: "conversation closed", vars: {} });
  h.evaluateActionRule.mockReset();
  sendText.mockClear();
  sendButtons.mockClear();
});

describe("startFlowsForEvent", () => {
  it("starts a background run with the event payload as variables", async () => {
    h.state.nodes = [node("a", "action", { step_type: "close_conversation", step_config: {} })];
    const n = await fire("conversation_closed", { conversation_id: "cv-9", trigger: { previous_status: "open" } });
    expect(n).toBe(1);
    const run = h.state.inserted.find((i) => i.table === "flow_runs")!.row;
    expect(run).toMatchObject({ exclusive: false, conversation_id: "cv-9", vars: { trigger: { previous_status: "open" } } });
  });

  it("ignores flows with another trigger, and conversation triggers", async () => {
    h.state.flows = [flow({ trigger_type: "conversation_opened" })];
    expect(await fire()).toBe(0);
    h.state.flows = [flow({ trigger_type: "keyword" })];
    expect(await fire("keyword")).toBe(0);
    expect(h.state.inserted).toHaveLength(0);
  });

  it("applies the trigger's filters (same matcher as automations)", async () => {
    h.state.flows = [flow({ trigger_type: "tag_added", trigger_config: { tag_id: "vip" } })];
    h.state.nodes = [node("a", "end", {})];
    expect(await fire("tag_added", { tag_id: "other" })).toBe(0);
    expect(await fire("tag_added", { tag_id: "vip" })).toBe(1);
  });

  it("needs a contact", async () => {
    expect(await startFlowsForEvent({ accountId: "acct-1", triggerType: "conversation_closed", contactId: null, context: {} })).toBe(0);
  });
});

describe("action nodes", () => {
  it("runs the Automation step and continues", async () => {
    h.state.nodes = [
      node("a", "action", { step_type: "create_deal", step_config: { pipeline_id: "p", stage_id: "s", title: "Deal" }, next_node_key: "b" }),
      node("b", "end", {}),
    ];
    await fire();
    expect(h.runActionStep).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct-1", contactId: "ct-1", sourceId: "flow:flow-1" }),
      { key: "flow-1:a", type: "create_deal", config: { pipeline_id: "p", stage_id: "s", title: "Deal" } },
    );
    expect(ended()).toMatchObject({ status: "completed", end_reason: "end_node" });
  });

  it("fails the run when the step throws", async () => {
    h.state.nodes = [node("a", "action", { step_type: "send_webhook", step_config: { url: "https://x" } })];
    h.runActionStep.mockRejectedValueOnce(new Error("webhook returned 500"));
    await fire();
    expect(ended()).toMatchObject({ status: "failed", end_reason: "action_failed" });
  });

  it("keeps variables a step produced", async () => {
    h.state.nodes = [node("a", "action", { step_type: "format_phone", step_config: { input: "98", output_var: "p" } })];
    h.runActionStep.mockResolvedValueOnce({ detail: "ok", vars: { p: "+9198" } });
    await fire();
    expect(runUpdates()).toContainEqual({ vars: { p: "+9198" } });
  });
});

describe("end of path", () => {
  it("completes (not fails) when nothing is connected after a step", async () => {
    h.state.nodes = [node("a", "action", { step_type: "close_conversation", step_config: {} })];
    await fire();
    expect(ended()).toMatchObject({ status: "completed", end_reason: "end_of_path" });
  });
});

describe("rule conditions", () => {
  it("branches on an Automation rule", async () => {
    h.state.nodes = [
      node("a", "condition", { rule: { subject: "working_hours" }, true_next: "yes", false_next: "no" }),
      node("yes", "end", {}),
      node("no", "action", { step_type: "close_conversation", step_config: {} }),
    ];
    h.evaluateActionRule.mockResolvedValueOnce(false);
    await fire();
    expect(h.evaluateActionRule).toHaveBeenCalledWith(expect.anything(), { subject: "working_hours" });
    expect(h.runActionStep).toHaveBeenCalledTimes(1);
  });
});

describe("delays", () => {
  it("parks the run on a Time Delay and frees the conversation", async () => {
    h.state.nodes = [node("a", "time_delay", { amount: 2, unit: "hours", next_node_key: "b" }), node("b", "end", {})];
    const before = Date.now();
    await fire();
    const park = runUpdates().find((p) => p.resume_at)!;
    expect(park).toMatchObject({ current_node_key: "a", exclusive: false, resume_locked_until: null });
    const at = Date.parse(park.resume_at as string);
    expect(at - before).toBeGreaterThanOrEqual(2 * 3_600_000 - 1000);
    expect(ended()).toBeUndefined();
  });

  it("Wait Till in the past skips ahead when asked to", async () => {
    h.state.nodes = [
      node("a", "wait_until", { at: "2020-01-01 09:00", if_past: "skip", next_node_key: "b" }),
      node("b", "end", {}),
    ];
    await fire();
    expect(runUpdates().find((p) => p.resume_at)).toBeUndefined();
    expect(ended()).toMatchObject({ status: "completed" });
  });

  it("rejects an invalid delay", async () => {
    h.state.nodes = [node("a", "time_delay", { amount: 0, unit: "hours" })];
    await fire();
    expect(ended()).toMatchObject({ status: "failed", end_reason: "delay_invalid" });
  });

  it("resumes due runs after the delay node", async () => {
    h.state.nodes = [
      node("a", "time_delay", { amount: 1, unit: "days", next_node_key: "b" }),
      node("b", "action", { step_type: "close_conversation", step_config: {} }),
    ];
    h.state.claimed = [
      { id: "run-1", flow_id: "flow-1", account_id: "acct-1", user_id: "u-1", contact_id: "ct-1", conversation_id: "cv-1", status: "active", current_node_key: "a", vars: {}, exclusive: false },
    ];
    expect(await resumeDueFlowRuns()).toBe(1);
    expect(runUpdates()[0]).toMatchObject({ resume_at: null, resume_locked_until: null });
    expect(h.runActionStep).toHaveBeenCalledTimes(1);
    expect(ended()).toMatchObject({ status: "completed", end_reason: "end_of_path" });
  });
});

describe("taking the conversation", () => {
  const buttons = node("a", "send_buttons", {
    body: "Pick one",
    buttons: [{ id: "b1", title: "Flat", next_node_key: "" }],
  });

  it("a background run claims the conversation before asking", async () => {
    h.state.nodes = [buttons];
    await fire();
    expect(runUpdates()[0]).toEqual({ exclusive: true });
    expect(sendButtons).toHaveBeenCalledTimes(1);
  });

  it("ends instead of interrupting another bot conversation", async () => {
    h.state.nodes = [buttons];
    h.state.holdError = { message: "duplicate key value violates unique constraint", code: "23505" };
    await fire();
    expect(sendButtons).not.toHaveBeenCalled();
    expect(ended()).toMatchObject({ status: "failed", end_reason: "contact_in_another_flow" });
  });
});
