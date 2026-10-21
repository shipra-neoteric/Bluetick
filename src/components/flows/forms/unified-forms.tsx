"use client";

/**
 * Forms for the One-Flow steps (migration 048): Time Delay, Wait Till,
 * Automation actions (close conversation, call API, create deal, start
 * another flow, …) and rule conditions. Actions and rules reuse the
 * Automation builder's editors, so both builders edit the same config.
 */

import { useTranslations } from "next-intl";
import { AutomationStepFields } from "@/components/automations/automation-builder";
import type { AutomationStepType } from "@/types";
import type { BuilderNode } from "../shared";
import { NextNodeRow } from "./fields";

const SELECT =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none";
const ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"];

interface Props {
  node: BuilderNode;
  allNodes: BuilderNode[];
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="mb-1 block text-xs text-muted-foreground">{children}</label>;
}

export function UnifiedNodeForm({ node, allNodes, onUpdateConfig }: Props) {
  const t = useTranslations("BotStudio.builder.form");
  const tf = useTranslations("Flows.builder.form");
  const cfg = node.config as Record<string, unknown>;
  const next = (
    <NextNodeRow
      value={String(cfg.next_node_key ?? "")}
      allNodes={allNodes}
      currentKey={node.node_key}
      onChange={(v) => onUpdateConfig({ next_node_key: v })}
      label={tf("advancesTo")}
    />
  );

  switch (node.node_type) {
    case "time_delay":
      return (
        <>
          <div>
            <Label>{t("waitFor")}</Label>
            <div className="flex gap-2">
              <input
                type="number"
                min={1}
                value={String(cfg.amount ?? 1)}
                onChange={(e) => onUpdateConfig({ amount: Number(e.target.value) })}
                className={`${SELECT} w-24`}
                aria-label={t("amount")}
              />
              <select
                value={String(cfg.unit ?? "hours")}
                onChange={(e) => onUpdateConfig({ unit: e.target.value })}
                className={SELECT}
                aria-label={t("unit")}
              >
                <option value="minutes">{t("minutes")}</option>
                <option value="hours">{t("hours")}</option>
                <option value="days">{t("days")}</option>
              </select>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("delayHint")}</p>
          {next}
        </>
      );

    case "wait_until":
      return (
        <>
          <div>
            <Label>{t("waitUntil")}</Label>
            <input
              value={String(cfg.at ?? "")}
              onChange={(e) => onUpdateConfig({ at: e.target.value })}
              placeholder="2026-12-01 10:00  /  {{contact.custom.visit_date}}"
              className={SELECT}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">{t("waitUntilHint", { token: "{{contact.custom.visit_date}}" })}</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>{t("timezone")}</Label>
              <select value={String(cfg.timezone ?? "Asia/Kolkata")} onChange={(e) => onUpdateConfig({ timezone: e.target.value })} className={SELECT}>
                {ZONES.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>{t("ifPast")}</Label>
              <select value={String(cfg.if_past ?? "run_now")} onChange={(e) => onUpdateConfig({ if_past: e.target.value })} className={SELECT}>
                <option value="run_now">{t("runNow")}</option>
                <option value="skip">{t("skip")}</option>
              </select>
            </div>
          </div>
          {next}
        </>
      );

    case "action":
      return (
        <>
          <AutomationStepFields
            type={String(cfg.step_type) as AutomationStepType}
            config={(cfg.step_config as Record<string, unknown>) ?? {}}
            onChange={(c) => onUpdateConfig({ step_config: c })}
          />
          {next}
        </>
      );

    default:
      return null;
  }
}

/** Condition with an Automation-style rule (time of day, working hours…). */
export function RuleConditionForm({ node, allNodes, onUpdateConfig }: Props) {
  const t = useTranslations("BotStudio.builder.form");
  const cfg = node.config as Record<string, unknown>;
  const rule = (cfg.rule as Record<string, unknown>) ?? {};
  return (
    <>
      <AutomationStepFields type="condition" config={rule} onChange={(c) => onUpdateConfig({ rule: c })} />
      <NextNodeRow value={String(cfg.true_next ?? "")} allNodes={allNodes} currentKey={node.node_key} onChange={(v) => onUpdateConfig({ true_next: v })} label={t("whenTrue")} />
      <NextNodeRow value={String(cfg.false_next ?? "")} allNodes={allNodes} currentKey={node.node_key} onChange={(v) => onUpdateConfig({ false_next: v })} label={t("whenFalse")} />
      <button type="button" onClick={() => onUpdateConfig({ rule: undefined })} className="text-left text-[11px] text-primary hover:underline">
        {t("useBasic")}
      </button>
    </>
  );
}
