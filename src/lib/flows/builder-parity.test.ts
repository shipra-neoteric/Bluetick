import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================
// Bot Builder parity (spec A03/A05/A10/A11/A13, T16.04): Send Message
// media + "On response", buttons "Any other reply", Time Delay
// dd/hh/mm/ss, Wait Till date/time/offset/weekly, several tags, and
// fresh start on event triggers. Real engine, fake Supabase.
// ============================================================

type Filter = [string, unknown];
const h = vi.hoisted(() => ({
  state: {
    flows: [] as Record<string, unknown>[],
    nodes: [] as Record<string, unknown>[],
    activeRuns: [] as Record<string, unknown>[],
    inserted: [] as { table: string; row: Record<string, unknown> }[],
    updates: [] as { table: string; payload: Record<string, unknown>; filters: Filter[] }[],
    insertedRun: null as Record<string, unknown> | null,
  },
  sendText: vi.fn(async () => ({ whatsapp_message_id: "wamid.t" })),
  sendMedia: vi.fn(async () => ({ whatsapp_message_id: "wamid.m" })),
  sendButtons: vi.fn(async () => ({ whatsapp_message_id: "wamid.b" })),
  addTag: vi.fn(async () => undefined),
  apiCall: vi.fn(),
}));

vi.mock("./admin-client", () => {
  function rows(table: string): unknown[] {
    if (table === "flows") return h.state.flows;
    if (table === "flow_nodes") return h.state.nodes;
    if (table === "flow_runs") return h.state.activeRuns;
    if (table === "conversations") return [{ id: "cv-1" }];
    if (table === "api_definitions") return [{ id: "api-1", name: "CRM", method: "POST", url: "https://crm.test/{{vars.x}}", headers: [], body: null, response_map: [] }];
    return [];
  }
  function builder(table: string) {
    let mode: "select" | "update" | "insert" = "select";
    let payload: Record<string, unknown> = {};
    const filters: Filter[] = [];
    const result = () => {
      if (mode === "update") {
        h.state.updates.push({ table, payload, filters: [...filters] });
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
      not: () => b,
      filter: () => b,
      order: () => b,
      limit: () => b,
      update: (p: Record<string, unknown>) => ((mode = "update"), (payload = p), b),
      insert: (row: Record<string, unknown>) => {
        mode = "insert";
        h.state.inserted.push({ table, row });
        if (table === "flow_runs") h.state.insertedRun = { id: "run-1", vars: {}, reprompt_count: 0, ...row };
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
      rpc: () => Promise.resolve({ data: null, error: null }),
    }),
  };
});

vi.mock("./meta-send", () => ({
  engineSendText: (...a: unknown[]) => (h.sendText as unknown as (...x: unknown[]) => unknown)(...a),
  engineSendMedia: (...a: unknown[]) => (h.sendMedia as unknown as (...x: unknown[]) => unknown)(...a),
  engineSendInteractiveButtons: (...a: unknown[]) => (h.sendButtons as unknown as (...x: unknown[]) => unknown)(...a),
  engineSendInteractiveList: vi.fn(async () => ({ whatsapp_message_id: "wamid.l" })),
}));
vi.mock("@/lib/contacts/tag-events", () => ({
  addContactTagAndDispatch: (...a: unknown[]) => (h.addTag as unknown as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/bot/call-api", () => ({
  performApiCall: (...a: unknown[]) => (h.apiCall as unknown as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/automations/engine", () => ({
  runActionStep: vi.fn(async () => ({ detail: "ok", vars: {} })),
  evaluateActionRule: vi.fn(async () => true),
  triggerMatches: () => true,
}));

import { delayMs, dispatchInboundToFlows, joinDateTime, startFlowsForEvent } from "./engine";
import { planWaitUntil } from "@/lib/bot/working-hours";

const node = (node_key: string, node_type: string, config: Record<string, unknown>) => ({ id: node_key, flow_id: "flow-1", node_key, node_type, config });
const flow = (over: Record<string, unknown> = {}) => ({
  id: "flow-1",
  account_id: "acct-1",
  user_id: "u-1",
  status: "active",
  trigger_type: "keyword",
  trigger_config: { keywords: ["hi"] },
  entry_node_id: "a",
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});
const run = (current: string, vars: Record<string, unknown> = {}) => ({
  id: "run-1",
  flow_id: "flow-1",
  account_id: "acct-1",
  user_id: "u-1",
  contact_id: "ct-1",
  conversation_id: "cv-1",
  status: "active",
  current_node_key: current,
  vars,
  reprompt_count: 0,
  exclusive: true,
});
const runUpdates = () => h.state.updates.filter((u) => u.table === "flow_runs").map((u) => u.payload);
const text = (t: string) =>
  dispatchInboundToFlows({
    accountId: "acct-1",
    userId: "u-1",
    contactId: "ct-1",
    conversationId: "cv-1",
    message: { kind: "text", text: t, meta_message_id: `m-${t}` },
    isFirstInboundMessage: false,
  });

beforeEach(() => {
  h.state.flows = [flow()];
  h.state.nodes = [];
  h.state.activeRuns = [];
  h.state.inserted = [];
  h.state.updates = [];
  h.state.insertedRun = null;
  h.sendText.mockClear();
  h.sendMedia.mockClear();
  h.sendButtons.mockClear();
  h.addTag.mockClear();
});

describe("Send Message (A05)", () => {
  it("sends an attachment with the body as caption", async () => {
    h.state.nodes = [node("a", "send_message", { text: "Brochure", media_url: "https://x.test/b.pdf", media_type: "document", filename: "b.pdf" })];
    await text("hi");
    expect(h.sendMedia).toHaveBeenCalledWith(expect.objectContaining({ kind: "document", link: "https://x.test/b.pdf", caption: "Brochure", filename: "b.pdf" }));
    expect(h.sendText).not.toHaveBeenCalled();
  });

  it("'On response' waits for the reply and stores it", async () => {
    h.state.nodes = [
      node("a", "send_message", { text: "Your city?", wait_reply: true, reply_var: "city", next_node_key: "b" }),
      node("b", "send_message", { text: "Thanks {{vars.city}}", next_node_key: "" }),
    ];
    const started = await text("hi");
    expect(started.outcome).toBe("started");
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(runUpdates().some((p) => p.current_node_key === "a")).toBe(true);

    h.state.activeRuns = [run("a")];
    h.sendText.mockClear();
    await text("Gwalior");
    expect(runUpdates()).toContainEqual({ vars: { city: "Gwalior" } });
    expect(h.sendText).toHaveBeenCalledWith(expect.objectContaining({ text: "Thanks Gwalior" }));
  });
});

describe("Buttons 'Any other reply' (A03.08)", () => {
  it("routes a non-matching reply to the other output instead of reprompting", async () => {
    h.state.nodes = [
      node("a", "send_buttons", { text: "Pick", buttons: [{ reply_id: "b1", title: "Flat", next_node_key: "" }], other_next: "c" }),
      node("c", "send_message", { text: "You said {{vars.last_reply}}", next_node_key: "" }),
    ];
    h.state.activeRuns = [run("a")];
    await text("a villa please");
    expect(h.sendButtons).not.toHaveBeenCalled(); // no reprompt
    expect(h.sendText).toHaveBeenCalledWith(expect.objectContaining({ text: "You said a villa please" }));
  });
});

describe("Add / Remove Tags (A13)", () => {
  it("adds every selected tag", async () => {
    h.state.nodes = [node("a", "set_tag", { mode: "add", tag_id: "", tag_ids: ["t1", "t2"], next_node_key: "" })];
    await text("hi");
    expect(h.addTag).toHaveBeenCalledTimes(2);
  });
});

describe("Time Delay dd/hh/mm/ss (A10)", () => {
  it("adds the parts up", () => {
    expect(delayMs({ days: 1, hours: 2, minutes: 3, seconds: 4 })).toBe(86_400_000 + 7_200_000 + 180_000 + 4_000);
  });
  it("still reads converted automations", () => {
    expect(delayMs({ amount: 2, unit: "hours" })).toBe(7_200_000);
    expect(delayMs({})).toBe(0);
  });
});

describe("Wait Till (A11)", () => {
  it("joins DD/MM/YYYY and HH:mm", () => {
    expect(joinDateTime("5/11/2026", "9:30")).toBe("2026-11-05 09:30");
    expect(joinDateTime("2026-11-05", "")).toBe("2026-11-05");
  });
  it("offset moves the time earlier", () => {
    const p = planWaitUntil({ at: "2030-01-10 10:00", timezone: "UTC", offset_minutes: 60 }, new Date("2030-01-01T00:00:00Z"));
    expect(p.ok && p.runAt.toISOString()).toBe("2030-01-10T09:00:00.000Z");
  });
  it("weekly repeat lands on the next occurrence, never in the past", () => {
    const now = new Date("2026-10-21T12:00:00Z"); // a Wednesday
    const p = planWaitUntil({ at: "2026-10-12 10:00", timezone: "UTC", repeat: "weekly" }, now); // a Monday
    expect(p.ok && p.past).toBe(false);
    expect(p.ok && p.runAt.toISOString()).toBe("2026-10-26T10:00:00.000Z");
  });
});

describe("Fresh start on an event trigger (T16.04)", () => {
  it("ends the contact's current bot conversation first", async () => {
    h.state.flows = [flow({ trigger_type: "incoming_webhook", trigger_config: { restart_policy: "restart" } })];
    h.state.nodes = [node("a", "end", {})];
    h.state.activeRuns = [run("x")];
    await startFlowsForEvent({ accountId: "acct-1", triggerType: "incoming_webhook", contactId: "ct-1", context: {} });
    expect(runUpdates()).toContainEqual(expect.objectContaining({ status: "completed", end_reason: "restarted_by_trigger" }));
  });
  it("leaves it alone without the checkbox", async () => {
    h.state.flows = [flow({ trigger_type: "incoming_webhook", trigger_config: {} })];
    h.state.nodes = [node("a", "end", {})];
    h.state.activeRuns = [run("x")];
    await startFlowsForEvent({ accountId: "acct-1", triggerType: "incoming_webhook", contactId: "ct-1", context: {} });
    expect(runUpdates().some((p) => p.end_reason === "restarted_by_trigger")).toBe(false);
  });
});

describe("Call Api (A20)", () => {
  const nodes = (failure = "f") => [
    node("a", "call_api", { api_id: "api-1", response_var: "resp", next_node_key: "ok", failure_next: failure }),
    node("ok", "send_message", { text: "Lead {{vars.lead_id}}", next_node_key: "" }),
    node("f", "send_message", { text: "Sorry ({{vars.api_status}})", next_node_key: "" }),
  ];
  it("success: maps the response into variables and takes the Success output", async () => {
    h.state.nodes = nodes();
    h.apiCall.mockResolvedValueOnce({ ok: true, status: 200, body: { id: 7 }, mapped: { lead_id: "L-7" } });
    await text("hi");
    expect(h.sendText).toHaveBeenCalledWith(expect.objectContaining({ text: "Lead L-7" }));
    expect(runUpdates()).toContainEqual({ vars: { lead_id: "L-7", resp: '{"id":7}', api_status: 200 } });
    // The URL template is filled from run variables on the server.
    const fill = h.apiCall.mock.calls[0][1] as (s: string) => string;
    expect(typeof fill).toBe("function");
  });
  it("failure: takes the Failure output when connected", async () => {
    h.state.nodes = nodes();
    h.apiCall.mockResolvedValueOnce({ ok: false, status: 500, body: "x", mapped: {}, error: "The API answered 500." });
    await text("hi");
    expect(h.sendText).toHaveBeenCalledWith(expect.objectContaining({ text: "Sorry (500)" }));
  });
  it("failure with nothing connected fails the run with the reason", async () => {
    h.state.nodes = nodes("");
    h.apiCall.mockResolvedValueOnce({ ok: false, status: 0, body: null, mapped: {}, error: "Could not reach the API." });
    await text("hi");
    expect(runUpdates()).toContainEqual(expect.objectContaining({ status: "failed", end_reason: "call_api_failed" }));
  });
});
