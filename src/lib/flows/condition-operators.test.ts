import { describe, expect, it } from "vitest";
import { evaluateConditionPredicate, regexProblem, safeRegexTest, toNumber } from "./matching";
import { validateFlowForActivation } from "./validate";
import type { ConditionOperator } from "./types";

const ok = (operator: ConditionOperator, subjectValue: string | undefined, configValue?: string) =>
  evaluateConditionPredicate({ operator, subjectValue, configValue });

describe("Bot Builder condition operators", () => {
  it("text comparisons, case-insensitive where named", () => {
    expect(ok("equals_ignore_case", "Pune ", "pune")).toBe(true);
    expect(ok("starts_with", "Interested in 2BHK", "interested")).toBe(true);
    expect(ok("ends_with", "lead@x.test", "@X.TEST")).toBe(true);
    expect(ok("not_contains", "hello", "bye")).toBe(true);
    expect(ok("not_equals", "a", "a")).toBe(false);
    // A missing value is not equal to / does not contain anything.
    expect(ok("not_equals", undefined, "a")).toBe(true);
    expect(ok("starts_with", undefined, "")).toBe(false);
  });

  it("handles Hindi and emoji text without corruption", () => {
    expect(ok("contains", "मुझे 2BHK चाहिए 🏠", "चाहिए")).toBe(true);
    expect(ok("equals_ignore_case", "हाँ", "हाँ")).toBe(true);
    expect(ok("ends_with", "ok 👍", "👍")).toBe(true);
  });

  it("numeric comparisons need numbers on both sides (no silent 0)", () => {
    expect(ok("gte", "50,00,000", "4000000")).toBe(true);
    expect(ok("gt", "10", "10")).toBe(false);
    expect(ok("lte", " 7.5 ", "7.5")).toBe(true);
    expect(ok("lt", "abc", "10")).toBe(false);
    expect(ok("gt", "", "0")).toBe(false);
    expect(toNumber("1e9")).toBeNull();
  });

  it("regex is bounded and never throws", () => {
    expect(ok("regex", "9876543210", "^[6-9][0-9]{9}$")).toBe(true);
    expect(ok("regex", "x", "(")).toBe(false);
    expect(safeRegexTest("a".repeat(201), "a")).toBe(false);
    expect(regexProblem("(")).not.toBeNull();
    expect(regexProblem("^ok$")).toBeNull();
  });

  it("unknown operators never take the true branch", () => {
    expect(ok("future_op" as ConditionOperator, "x", "x")).toBe(false);
  });

  it("activation rejects an invalid regex or a non-number comparison", () => {
    const flow = (operator: string, value: string) =>
      validateFlowForActivation({ name: "c", trigger_type: "manual", trigger_config: {}, entry_node_id: "c1" }, [
        { node_key: "c1", node_type: "condition", config: { subject: "var", subject_key: "x", operator, value, true_next: "", false_next: "" } },
      ]);
    expect(flow("regex", "(").some((i) => i.field === "value" && i.severity === "error")).toBe(true);
    expect(flow("gte", "ten").some((i) => i.field === "value" && i.severity === "error")).toBe(true);
    expect(flow("gte", "{{vars.budget}}").some((i) => i.field === "value" && i.severity === "error")).toBe(false);
    expect(flow("starts_with", "hi").some((i) => i.field === "operator")).toBe(false);
  });
});
