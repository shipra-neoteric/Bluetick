"use client";

/**
 * Flow settings (canvas + list): trigger, keyword matching options,
 * restart behaviour, and the fallback policy (unknown reply / timeout),
 * which existed in the database but had no editor before.
 */

import { Settings2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useFlowEditor } from "./flow-editor-state";
import { TriggerPanel } from "./flow-builder";
export { KeywordOptions } from "./keyword-options";

const SELECT =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none";

export function FlowSettingsSheet() {
  const t = useTranslations("BotStudio.flows.settings");
  const tf = useTranslations("Flows.builder");
  const { state, setState, issues } = useFlowEditor();
  const fp = state.fallback_policy;
  const setFp = (patch: Partial<typeof fp>) => setState((s) => ({ ...s, fallback_policy: { ...s.fallback_policy, ...patch } }));

  return (
    <Sheet>
      <SheetTrigger render={<Button variant="outline" size="sm" />}>
        <Settings2 className="h-3.5 w-3.5" />
        {t("open")}
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("subtitle")}</SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-5 py-4">
          <TriggerPanel
            state={state}
            setState={setState as never}
            triggerIssues={issues.filter((i) => i.scope === "trigger")}
            t={tf}
          />
          <section className="space-y-3 rounded-lg border border-border bg-card p-4">
            <h3 className="text-sm font-semibold">{t("fallbackTitle")}</h3>
            <p className="text-[11px] text-muted-foreground">{t("fallbackHint")}</p>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">{t("onUnknown")}</label>
              <select value={fp.on_unknown_reply} onChange={(e) => setFp({ on_unknown_reply: e.target.value as typeof fp.on_unknown_reply })} className={SELECT}>
                <option value="reprompt">{t("unknownReprompt")}</option>
                <option value="handoff">{t("unknownHandoff")}</option>
                <option value="ignore">{t("unknownIgnore")}</option>
              </select>
            </div>
            {fp.on_unknown_reply === "reprompt" && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">{t("maxReprompts")}</label>
                  <Input type="number" min={0} max={10} value={fp.max_reprompts} onChange={(e) => setFp({ max_reprompts: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })} className="bg-muted" />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-muted-foreground">{t("thenDo")}</label>
                  <select value={fp.on_exhaust} onChange={(e) => setFp({ on_exhaust: e.target.value as typeof fp.on_exhaust })} className={SELECT}>
                    <option value="handoff">{t("exhaustHandoff")}</option>
                    <option value="end">{t("exhaustEnd")}</option>
                  </select>
                </div>
              </div>
            )}
            {fp.on_unknown_reply === "ignore" && <p className="text-[11px] text-muted-foreground">{t("ignoreHint")}</p>}
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">{t("timeoutHours")}</label>
              <Input type="number" min={1} max={720} value={fp.on_timeout_hours} onChange={(e) => setFp({ on_timeout_hours: Math.max(1, Math.min(720, Number(e.target.value) || 24)) })} className="bg-muted" />
              <p className="mt-1 text-[11px] text-muted-foreground">{t("timeoutHint")}</p>
            </div>
          </section>
          <p className="text-[11px] text-muted-foreground">{t("saveNote")}</p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
