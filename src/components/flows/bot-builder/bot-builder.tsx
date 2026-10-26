"use client";

/**
 * Bot Builder — the Bot Studio layout for a Flow:
 *
 *   ┌ Bot Builder ─────────────────────────────────────────── × ┐
 *   │ Triggers | Actions │ <name> ✎     [issues] ↶ ↷ … ○ Enabled  Save │
 *   │ search             │                                          │
 *   │ SECTION ˄          │   [Starting point] ──▶ [card] ──▶ [card]  │
 *   │ [item] [item] …    │                                          │
 *   │                    │ + − ⛶ 🔒                                  │
 *   └────────────────────┴──────────────────────────────────────────┘
 *
 * One flow, one trigger (any Bluetick trigger: chat keyword, ad click,
 * conversation closed, webhook…), any steps (messages, delays, tags,
 * assignment, API calls…). Enabled = the flow is live; Save on a live
 * flow publishes the changes. Settings, Test, runs, list view, undo and
 * delete stay one click away.
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useReactFlow } from "@xyflow/react";
import { CircleAlert, Copy, History, List, Loader2, MoreHorizontal, Pencil, Redo2, Trash2, Undo2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AutomationResourcesProvider } from "@/components/automations/automation-builder";
import { useFlowEditor } from "../flow-editor-state";
import { FlowSettingsSheet } from "../flow-settings-sheet";
import { SimulatorSheet } from "../simulator-sheet";
import { ValidationPanel } from "../validation-panel";
import { BuilderCanvas } from "./canvas";
import { SidePanel } from "./side-panel";
import type { CatalogItem } from "./catalog";

export function BotBuilder({ onListView }: { onListView: () => void }) {
  const t = useTranslations("BotStudio.builder");
  const router = useRouter();
  const rf = useReactFlow();
  const {
    flow,
    state,
    setState,
    dirty,
    saving,
    activating,
    issues,
    addNode,
    save,
    setStatus,
    deleteFlow,
    duplicateFlow,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useFlowEditor();
  const [tab, setTab] = useState<"triggers" | "actions">("actions");
  const [nameFocus, setNameFocus] = useState(false);
  const live = state.status === "active";
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;

  // Unsaved changes: Cancel / Confirm dialog (B02.12).
  const [confirmClose, setConfirmClose] = useState(false);
  const close = () => {
    if (dirty) setConfirmClose(true);
    else router.push("/flows");
  };

  const pickTrigger = useCallback(
    (item: Extract<CatalogItem, { kind: "trigger" }>) => {
      if (item.trigger === state.trigger_type) return;
      setState((s) => ({ ...s, trigger_type: item.trigger, trigger_config: { ...(item.config ?? {}) } }));
      toast.success(t("triggerChanged", { name: t(`items.${item.id}`) }), {
        action: { label: t("undo"), onClick: () => undo() },
      });
    },
    [setState, state.trigger_type, t, undo],
  );

  const addItem = useCallback(
    (item: Extract<CatalogItem, { kind: "action" }>, at?: { x: number; y: number }) => {
      let pos = at;
      if (!pos) {
        const root = document.querySelector(".bb-canvas") as HTMLElement | null;
        if (root) {
          const r = root.getBoundingClientRect();
          const c = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
          pos = { x: c.x - 135, y: c.y - 100 };
        }
      }
      const key = addNode(item.node, { config: item.preset, position: pos });
      // The first step is where the trigger leads.
      if (!state.entry_node_id) setState((s) => ({ ...s, entry_node_id: s.entry_node_id ?? key }));
    },
    [addNode, rf, setState, state.entry_node_id],
  );

  const onSave = () => void (live ? setStatus("active") : save());

  return (
    <div className="fixed inset-0 z-50 flex bg-black/45 p-2 sm:p-4" role="dialog" aria-modal="true" aria-label={t("title")}>
      <div className="bg-card flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg shadow-2xl">
        <div className="bg-muted/60 border-border flex items-center justify-between border-b px-5 py-3">
          <h1 className="text-[17px] font-semibold">{t("title")}</h1>
          <button type="button" onClick={close} aria-label={t("close")} className="text-muted-foreground hover:text-foreground rounded p-1">
            <X className="h-5 w-5" />
          </button>
        </div>

        <AutomationResourcesProvider>
          <div className="flex min-h-0 flex-1">
            <SidePanel tab={tab} onTab={setTab} currentTrigger={state.trigger_type} onPickTrigger={pickTrigger} onAddAction={addItem} />

            <div className="flex min-w-0 flex-1 flex-col">
              <div className="border-border flex flex-wrap items-center gap-2 border-b px-5 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <input
                    id="bb-name"
                    value={state.name}
                    onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
                    onFocus={() => setNameFocus(true)}
                    onBlur={() => setNameFocus(false)}
                    aria-label={t("name")}
                    className={cn(
                      "min-w-[120px] max-w-[360px] rounded border border-transparent bg-transparent px-1 py-0.5 text-[18px] font-semibold outline-none",
                      nameFocus && "border-emerald-600",
                    )}
                  />
                  <button type="button" onClick={() => document.getElementById("bb-name")?.focus()} aria-label={t("rename")} className="hover:text-emerald-600">
                    <Pencil className="h-4 w-4" />
                  </button>
                  {dirty && <span className="text-[11px] font-medium text-amber-600">{t("unsaved")}</span>}
                </div>

                <div className="ml-auto flex flex-wrap items-center gap-1.5">
                  {issues.length > 0 && (
                    <Popover>
                      <PopoverTrigger
                        className={cn(
                          "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] font-medium",
                          errors ? "border-red-500/40 text-red-600" : "border-amber-500/40 text-amber-600",
                        )}
                      >
                        <CircleAlert className="h-3.5 w-3.5" />
                        {t("issues", { errors, warnings })}
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-[420px] p-0">
                        <ValidationPanel />
                      </PopoverContent>
                    </Popover>
                  )}
                  <Button variant="ghost" size="sm" onClick={undo} disabled={!canUndo} aria-label={t("undo")} title={t("undo")}>
                    <Undo2 className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={redo} disabled={!canRedo} aria-label={t("redo")} title={t("redo")}>
                    <Redo2 className="h-4 w-4" />
                  </Button>
                  <FlowSettingsSheet />
                  <SimulatorSheet />
                  <DropdownMenu>
                    <DropdownMenuTrigger aria-label={t("more")} className="hover:bg-muted rounded-md p-1.5">
                      <MoreHorizontal className="h-4 w-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem onClick={() => router.push(`/flows/${flow.id}/runs`)}>
                        <History className="h-4 w-4" />
                        {t("runs", { count: flow.execution_count })}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={onListView}>
                        <List className="h-4 w-4" />
                        {t("listView")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void duplicateFlow()}>
                        <Copy className="h-4 w-4" />
                        {t("duplicateFlow")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => void deleteFlow()} className="text-red-500">
                        <Trash2 className="h-4 w-4" />
                        {t("deleteFlow")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <label className="ml-2 flex items-center gap-2 text-[14px]">
                    <Switch
                      checked={live}
                      disabled={activating}
                      onCheckedChange={(on) => void setStatus(on ? "active" : "draft")}
                      className="data-[checked]:bg-emerald-600 h-6 w-11 [&>span]:h-5 [&>span]:w-5 [&>span]:data-[checked]:translate-x-5"
                      aria-label={live ? t("enabled") : t("disabled")}
                    />
                    {activating ? <Loader2 className="h-4 w-4 animate-spin" /> : live ? t("enabled") : t("disabled")}
                  </label>
                  <Button variant="outline" size="sm" onClick={onSave} disabled={saving || activating} className="ml-1 px-4">
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t("save")}
                  </Button>
                </div>
              </div>

              <div className="relative min-h-0 flex-1">
                <BuilderCanvas onAddItem={addItem} onShowTriggers={() => setTab("triggers")} />
              </div>
            </div>
          </div>
        </AutomationResourcesProvider>
      </div>
      <Dialog open={confirmClose} onOpenChange={setConfirmClose}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("leaveTitle")}</DialogTitle>
            <DialogDescription>{t("leaveUnsaved")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClose(false)}>{t("cancel")}</Button>
            <Button onClick={() => router.push("/flows")} className="bg-red-600 text-white hover:bg-red-700">{t("confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
