"use client";

/**
 * Inside the "Starting point" card. "On Message" (keyword) is edited with
 * keyword rows, "Partially match", "Add Keyword +",
 * "fresh start". Every other trigger shows what it reacts to plus its
 * filters (the same editor Automations use).
 */

import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { AutomationTriggerFields } from "@/components/automations/automation-builder";
import type { AutomationTriggerType } from "@/types";
import { useFlowEditor } from "../flow-editor-state";

const MAX_KEYWORD = 200;

export function TriggerBody() {
  const t = useTranslations("BotStudio.builder");
  const { flow, state, setState } = useFlowEditor();
  const cfg = state.trigger_config ?? {};
  const set = (patch: Record<string, unknown>) =>
    setState((s) => ({ ...s, trigger_config: { ...s.trigger_config, ...patch } }));

  if (state.trigger_type === "keyword") {
    const keywords = Array.isArray(cfg.keywords) ? (cfg.keywords as string[]) : [];
    const setKw = (next: string[]) => set({ keywords: next });
    return (
      <div className="flex flex-col gap-2">
        {keywords.map((k, i) => (
          <div key={i}>
            <div className="border-border flex items-center gap-1 rounded-md border px-2 py-1.5">
              <input
                value={k}
                maxLength={MAX_KEYWORD}
                onChange={(e) => setKw(keywords.map((x, j) => (j === i ? e.target.value : x)))}
                placeholder={t("keywordPlaceholder")}
                aria-label={t("keyword")}
                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              />
              <button
                type="button"
                onClick={() => setKw(keywords.filter((_, j) => j !== i))}
                aria-label={t("removeKeyword")}
                className="text-muted-foreground hover:text-red-500"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="text-muted-foreground mt-0.5 text-right text-[10px]">
              ({k.length}/{MAX_KEYWORD})
            </div>
          </div>
        ))}
        <label className="flex items-center gap-2 text-[12.5px]">
          <input
            type="checkbox"
            className="accent-emerald-600"
            checked={cfg.match_type !== "exact"}
            onChange={(e) => set({ match_type: e.target.checked ? "contains" : "exact" })}
          />
          {t("partialMatch")}
        </label>
        <button
          type="button"
          onClick={() => setKw([...keywords, ""])}
          className="flex items-center justify-center gap-1 rounded-md border border-emerald-600 py-1.5 text-[13px] font-medium text-emerald-700 hover:bg-emerald-600/5 dark:text-emerald-400"
        >
          {t("addKeyword")} <Plus className="h-3.5 w-3.5" />
        </button>
        <label className="flex items-start gap-2 text-[12.5px] leading-snug">
          <input
            type="checkbox"
            className="mt-0.5 accent-emerald-600"
            checked={cfg.restart_policy === "restart"}
            onChange={(e) => set({ restart_policy: e.target.checked ? "restart" : "continue" })}
          />
          {t("freshStart")}
        </label>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 text-[12.5px]">
      <p className="text-muted-foreground leading-snug">{t(`triggerHelp.${state.trigger_type}`)}</p>
      {state.trigger_type !== "manual" && state.trigger_type !== "first_inbound_message" && (
        <AutomationTriggerFields
          type={state.trigger_type as AutomationTriggerType}
          config={cfg}
          onChange={(c) => setState((s) => ({ ...s, trigger_config: c }))}
          hookApi={`/api/flows/${flow.id}/webhook`}
        />
      )}
      {state.trigger_type !== "manual" && state.trigger_type !== "first_inbound_message" && (
        <label className="flex items-start gap-2 leading-snug">
          <input
            type="checkbox"
            className="mt-0.5 accent-emerald-600"
            checked={cfg.restart_policy === "restart"}
            onChange={(e) => set({ restart_policy: e.target.checked ? "restart" : undefined })}
          />
          {t("freshStart")}
        </label>
      )}
    </div>
  );
}
