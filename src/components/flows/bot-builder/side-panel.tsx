"use client";

/**
 * Left panel of the Bot Builder: Triggers | Actions
 * tabs with a green underline, one search box, collapsible upper-case
 * sections and outlined item rows. Actions can be clicked (added in view)
 * or dragged onto the canvas; a trigger replaces the flow's trigger.
 * Locked items need an integration Bluetick doesn't have: shown with a
 * lock and the reason, never clickable.
 */

import { useMemo, useState } from "react";
import { ChevronUp, Lock, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { NODE_DRAG_TYPE } from "../node-palette";
import { ACTION_SECTIONS, TRIGGER_SECTIONS, type CatalogItem } from "./catalog";

export function SidePanel({
  tab,
  onTab,
  currentTrigger,
  onPickTrigger,
  onAddAction,
}: {
  tab: "triggers" | "actions";
  onTab: (t: "triggers" | "actions") => void;
  currentTrigger: string;
  onPickTrigger: (item: Extract<CatalogItem, { kind: "trigger" }>) => void;
  onAddAction: (item: Extract<CatalogItem, { kind: "action" }>) => void;
}) {
  const t = useTranslations("BotStudio.builder");
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());

  const sections = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // One search across both tabs ("Search Action and Triggers").
    const src = needle ? [...TRIGGER_SECTIONS, ...ACTION_SECTIONS] : tab === "triggers" ? TRIGGER_SECTIONS : ACTION_SECTIONS;
    return src
      .map((s) => ({ ...s, items: s.items.filter((i) => !needle || t(`items.${i.id}`).toLowerCase().includes(needle)) }))
      .filter((s) => s.items.length > 0);
  }, [q, tab, t]);

  return (
    <aside className="border-border bg-card flex h-full w-[330px] shrink-0 flex-col border-r" aria-label={t("panelLabel")}>
      <div className="border-border grid grid-cols-2 border-b" role="tablist">
        {(["triggers", "actions"] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => onTab(k)}
            className={cn(
              "border-b-2 py-3.5 text-[16px] font-semibold transition-colors",
              tab === k ? "border-emerald-600 text-foreground" : "text-muted-foreground hover:text-foreground border-transparent",
            )}
          >
            {t(k)}
          </button>
        ))}
      </div>
      <div className="p-4 pb-2">
        <label className="border-border bg-card flex items-center gap-2.5 rounded-md border px-3 py-2.5">
          <Search className="text-muted-foreground h-5 w-5 shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("search")}
            aria-label={t("search")}
            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-[15px] outline-none"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {sections.length === 0 && <p className="text-muted-foreground px-4 py-8 text-center text-sm">{t("noMatch")}</p>}
        {sections.map((s) => {
          const isClosed = closed.has(s.id) && !q;
          return (
            <section key={s.id} className="border-border border-b px-4 py-3 last:border-b-0">
              <button
                type="button"
                onClick={() =>
                  setClosed((prev) => {
                    const next = new Set(prev);
                    if (next.has(s.id)) next.delete(s.id);
                    else next.add(s.id);
                    return next;
                  })
                }
                aria-expanded={!isClosed}
                className="text-muted-foreground hover:text-foreground flex w-full items-center justify-between pb-2 text-[13px] font-semibold tracking-wide uppercase"
              >
                {t(`sections.${s.id}`)}
                <ChevronUp className={cn("h-4 w-4 transition-transform", isClosed && "rotate-180")} />
              </button>
              {!isClosed && (
                <div className="flex flex-col gap-2">
                  {s.items.map((item) => (
                    <PanelItem
                      key={item.id}
                      item={item}
                      label={t(`items.${item.id}`)}
                      active={item.kind === "trigger" && item.trigger === currentTrigger}
                      lockedHint={t("lockedHint")}
                      onPick={() => {
                        if (item.kind === "trigger") onPickTrigger(item);
                        else if (item.kind === "action") onAddAction(item);
                      }}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function PanelItem({
  item,
  label,
  active,
  lockedHint,
  onPick,
}: {
  item: CatalogItem;
  label: string;
  active: boolean;
  lockedHint: string;
  onPick: () => void;
}) {
  const t = useTranslations("BotStudio.builder");
  const Icon = item.icon;
  const isLocked = item.kind === "locked";
  const [why, setWhy] = useState(false);
  if (isLocked) {
    // Not a commercial lock: Bluetick has no such integration yet. Clicking
    // shows exactly what would be needed (no fake setup).
    return (
      <div>
        <button
          type="button"
          onClick={() => setWhy((v) => !v)}
          aria-expanded={why}
          title={lockedHint}
          className="border-border bg-card flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left text-[15px] font-medium opacity-80"
        >
          <Icon className={cn("h-5 w-5 shrink-0", item.color)} />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <Lock className="h-4 w-4 shrink-0" aria-label={lockedHint} />
        </button>
        {why && <p className="text-muted-foreground px-1 pt-1 text-[11.5px] leading-snug">{t(`locked.${item.id}`)}</p>}
      </div>
    );
  }
  return (
    <button
      type="button"
      disabled={isLocked}
      draggable={item.kind === "action"}
      onDragStart={(e) => {
        if (item.kind !== "action") return;
        e.dataTransfer.setData(NODE_DRAG_TYPE, item.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={onPick}
      title={isLocked ? lockedHint : undefined}
      className={cn(
        "border-border bg-card flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left text-[15px] font-medium transition-colors",
        isLocked ? "cursor-not-allowed opacity-80" : "hover:border-emerald-600/60 hover:bg-emerald-600/5",
        active && "border-emerald-600 bg-emerald-600/5",
        item.kind === "action" && "cursor-grab active:cursor-grabbing",
      )}
    >
      <Icon className={cn("h-5 w-5 shrink-0", item.color)} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {isLocked && <Lock className="h-4 w-4 shrink-0" aria-label={lockedHint} />}
    </button>
  );
}
