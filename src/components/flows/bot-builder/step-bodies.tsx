"use client";

/**
 * Bodies for logic / customer / data cards:
 *   - Time Delay (A10): dd / hh / mm / ss.
 *   - Wait Till (A11): repeat, date (typed, calendar or {}), 24-hour time,
 *     timezone, "Trigger before scheduled time +", if the time has passed.
 *   - Add / Remove Tags (A13) and Add to Broadcast Lists (A14): radios +
 *     multi-select of real tags (a broadcast list is a tag in Bluetick).
 *   - Send Template (A06): searchable approved templates, preview,
 *     variables, optional header media.
 *   - Call Api (A20): saved API selector + editor dialog.
 * Resources (tags, templates) come from the shared automation resources
 * provider mounted once by the Bot Builder.
 */

import { useMemo, useState } from "react";
import { CalendarDays, Plus, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useAutomationResources } from "@/components/automations/automation-builder";
import type { ExtraVariable } from "@/components/bot/variable-picker";
import type { BuilderNode } from "../shared";
import { Label, MediaPicker, VarText } from "./message-bodies";

const FIELD = "border-border w-full rounded-md border bg-transparent px-2 py-1.5 text-[13px] outline-none focus:border-emerald-600";
const num = (v: unknown) => (v === undefined || v === null || v === "" ? "" : String(v));

// ── Time Delay ──────────────────────────────────────────────────────

export function TimeDelayBody({ node, onUpdate }: { node: BuilderNode; onUpdate: (p: Record<string, unknown>) => void }) {
  const t = useTranslations("BotStudio.builder");
  const c = node.config as Record<string, unknown>;
  // Converted automations store amount + unit; show them as dd/hh/mm.
  const legacy = c.amount != null && c.days == null && c.hours == null && c.minutes == null && c.seconds == null;
  const v = legacy
    ? { days: c.unit === "days" ? c.amount : 0, hours: c.unit === "hours" ? c.amount : 0, minutes: c.unit === "minutes" || !c.unit ? c.amount : 0, seconds: 0 }
    : { days: c.days, hours: c.hours, minutes: c.minutes, seconds: c.seconds };
  const set = (k: "days" | "hours" | "minutes" | "seconds", raw: string) =>
    onUpdate({ ...v, amount: undefined, unit: undefined, [k]: raw === "" ? 0 : Math.max(0, Math.min(Number(raw) || 0, k === "days" ? 365 : 59)) });
  return (
    <div>
      <div className="grid grid-cols-4 gap-1.5">
        {(["days", "hours", "minutes", "seconds"] as const).map((k) => (
          <label key={k} className="flex flex-col items-center gap-0.5">
            <input type="number" min={0} value={num(v[k])} onChange={(e) => set(k, e.target.value)} className={cn(FIELD, "text-center")} aria-label={t(`delay.${k}`)} />
            <span className="text-muted-foreground text-[10.5px]">{t(`delay.${k}Short`)}</span>
          </label>
        ))}
      </div>
      <p className="text-muted-foreground mt-1.5 text-[10.5px]">{t("delay.hint")}</p>
    </div>
  );
}

// ── Wait Till ───────────────────────────────────────────────────────

const ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Riyadh", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Australia/Sydney", "UTC"];

export function WaitTillBody({ node, vars, onUpdate }: { node: BuilderNode; vars: ExtraVariable[]; onUpdate: (p: Record<string, unknown>) => void }) {
  const t = useTranslations("BotStudio.builder");
  const c = node.config as Record<string, unknown>;
  const [offsetOpen, setOffsetOpen] = useState(Boolean(c.offset_days || c.offset_hours || c.offset_minutes));
  const s = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : "");
  // A converted automation keeps its single "at" value until edited here.
  if (s("at") && !s("date")) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label>{t("waitTill.at")}</Label>
        <VarText value={s("at")} onChange={(v) => onUpdate({ at: v })} vars={vars} />
        <button type="button" className="text-left text-[11px] text-emerald-700 underline dark:text-emerald-400" onClick={() => onUpdate({ at: undefined, date: "", time: "09:00" })}>
          {t("waitTill.switch")}
        </button>
      </div>
    );
  }
  const isoFromDmy = (d: string) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d);
    return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
  };
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Label>{t("waitTill.repeat")}</Label>
        <select value={s("repeat") || "none"} onChange={(e) => onUpdate({ repeat: e.target.value })} className={FIELD}>
          <option value="none">{t("waitTill.noRepeat")}</option>
          <option value="weekly">{t("waitTill.weekly")}</option>
        </select>
      </div>
      <div>
        <Label>{t("waitTill.date")}</Label>
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <VarText value={s("date")} onChange={(v) => onUpdate({ date: v })} vars={vars} placeholder="DD/MM/YYYY" ariaLabel={t("waitTill.date")} />
          </div>
          <label className="border-border hover:bg-muted relative mt-0 cursor-pointer rounded-md border p-1.5" title={t("waitTill.calendar")}>
            <CalendarDays className="h-4 w-4" />
            <input
              type="date"
              value={isoFromDmy(s("date"))}
              onChange={(e) => {
                const [y, m, d] = e.target.value.split("-");
                if (y) onUpdate({ date: `${d}/${m}/${y}` });
              }}
              className="absolute inset-0 cursor-pointer opacity-0"
              aria-label={t("waitTill.calendar")}
            />
          </label>
        </div>
      </div>
      <div>
        <Label>{t("waitTill.time")}</Label>
        <VarText value={s("time")} onChange={(v) => onUpdate({ time: v })} vars={vars} placeholder="hh:mm" ariaLabel={t("waitTill.time")} />
      </div>
      <div>
        <Label>{t("waitTill.timezone")}</Label>
        <select value={s("timezone") || "Asia/Kolkata"} onChange={(e) => onUpdate({ timezone: e.target.value })} className={FIELD}>
          {(ZONES.includes(s("timezone")) || !s("timezone") ? ZONES : [s("timezone"), ...ZONES]).map((z) => (
            <option key={z} value={z}>{z}</option>
          ))}
        </select>
      </div>
      {!offsetOpen ? (
        <button type="button" onClick={() => setOffsetOpen(true)} className="inline-flex items-center gap-1 self-start text-[12px] font-medium text-emerald-700 dark:text-emerald-400">
          {t("waitTill.before")} <Plus className="h-3.5 w-3.5" />
        </button>
      ) : (
        <div className="border-border rounded-md border p-1.5">
          <div className="mb-1 flex items-center justify-between text-[12px] font-medium">
            {t("waitTill.before")}
            <button type="button" aria-label={t("waitTill.removeOffset")} onClick={() => { setOffsetOpen(false); onUpdate({ offset_days: 0, offset_hours: 0, offset_minutes: 0 }); }}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {(["offset_days", "offset_hours", "offset_minutes"] as const).map((k) => (
              <label key={k} className="flex flex-col items-center gap-0.5">
                <input type="number" min={0} value={num(c[k])} onChange={(e) => onUpdate({ [k]: Math.max(0, Number(e.target.value) || 0) })} className={cn(FIELD, "text-center")} />
                <span className="text-muted-foreground text-[10.5px]">{t(`waitTill.${k}`)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div>
        <Label>{t("waitTill.ifPast")}</Label>
        <select value={s("if_past") || "run_now"} onChange={(e) => onUpdate({ if_past: e.target.value })} className={FIELD}>
          <option value="run_now">{t("waitTill.runNow")}</option>
          <option value="skip">{t("waitTill.skip")}</option>
        </select>
      </div>
    </div>
  );
}

// ── Tags / Broadcast lists ──────────────────────────────────────────

export function TagsBody({ node, onUpdate }: { node: BuilderNode; onUpdate: (p: Record<string, unknown>) => void }) {
  const t = useTranslations("BotStudio.builder");
  const { tags } = useAutomationResources();
  const c = node.config as { mode?: string; tag_id?: string; tag_ids?: string[]; variant?: string };
  const lists = c.variant === "broadcast_list";
  const selected = c.tag_ids?.length ? c.tag_ids : c.tag_id ? [c.tag_id] : [];
  const [q, setQ] = useState("");
  const options = tags.filter((x) => !selected.includes(x.id) && x.name.toLowerCase().includes(q.toLowerCase()));
  const set = (ids: string[]) => onUpdate({ tag_ids: ids, tag_id: ids[0] ?? "" });
  return (
    <div className="flex flex-col gap-2">
      {!lists && (
        <div className="flex gap-3 text-[12.5px]">
          {(["add", "remove"] as const).map((m) => (
            <label key={m} className="flex items-center gap-1.5">
              <input type="radio" className="accent-emerald-600" checked={(c.mode ?? "add") === m} onChange={() => onUpdate({ mode: m })} />
              {t(m === "add" ? "tags.add" : "tags.remove")}
            </label>
          ))}
        </div>
      )}
      <Label>{t(lists ? "tags.selectLists" : "tags.choose")}</Label>
      <div className="flex flex-wrap gap-1">
        {selected.map((id) => (
          <span key={id} className="inline-flex items-center gap-1 rounded-full border border-emerald-600/40 bg-emerald-600/10 px-2 py-0.5 text-[11.5px]">
            {tags.find((x) => x.id === id)?.name ?? t("tags.missing")}
            <button type="button" aria-label={t("tags.removeChip")} onClick={() => set(selected.filter((x) => x !== id))}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="border-border rounded-md border">
        <div className="border-border flex items-center gap-1 border-b px-2 py-1">
          <Search className="text-muted-foreground h-3.5 w-3.5" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("tags.search")} className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none" />
        </div>
        <div className="max-h-28 overflow-y-auto py-1">
          {tags.length === 0 && <p className="text-muted-foreground px-2 py-1 text-[11.5px]">{t("tags.none")}</p>}
          {options.map((x) => (
            <button key={x.id} type="button" onClick={() => set([...selected, x.id])} className="hover:bg-muted block w-full truncate px-2 py-1 text-left text-[12.5px]">
              {x.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Send Template ───────────────────────────────────────────────────

export function TemplateBody({ node, vars, onUpdate }: { node: BuilderNode; vars: ExtraVariable[]; onUpdate: (p: Record<string, unknown>) => void }) {
  const t = useTranslations("BotStudio.builder");
  const { templates, reloadTemplates } = useAutomationResources();
  const [syncing, setSyncing] = useState(false);
  const c = node.config as { template_name?: string; language?: string; params?: string[]; header_media_url?: string };
  // Approved templates come from Meta; pull the latest list on request.
  const sync = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/whatsapp/templates/sync", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      await reloadTemplates();
      toast.success(t("template.synced"));
    } catch (err) {
      toast.error(t("template.syncFailed", { reason: err instanceof Error ? err.message : "" }));
    } finally {
      setSyncing(false);
    }
  };
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(!c.template_name);
  const current = templates.find((x) => x.name === c.template_name && (x.language ?? "") === (c.language ?? ""));
  const filtered = useMemo(() => templates.filter((x) => x.name.toLowerCase().includes(q.toLowerCase())), [templates, q]);
  const varCount = new Set((current?.body_text ?? "").match(/\{\{\s*\d+\s*\}\}/g) ?? []).size;
  const params = c.params ?? [];
  const mediaHeader = current?.header_type && current.header_type !== "text";
  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={() => setOpen((v) => !v)} className={cn(FIELD, "flex items-center justify-between text-left")}>
        <span className={cn("truncate", !current && "text-muted-foreground")}>{current ? `${current.name} · ${current.language ?? ""}` : c.template_name || t("template.select")}</span>
      </button>
      {open && (
        <div className="border-border rounded-md border">
          <div className="border-border flex items-center gap-1 border-b px-2 py-1">
            <Search className="text-muted-foreground h-3.5 w-3.5" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("template.search")} className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none" />
          </div>
          <div className="max-h-40 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <div className="px-2 py-1 text-[11.5px] leading-snug">
                <p className="text-muted-foreground">{templates.length === 0 ? t("template.noneHelp") : t("template.none")}</p>
                {templates.length === 0 && (
                  <button
                    type="button"
                    onClick={() => void sync()}
                    disabled={syncing}
                    className="mt-1 font-medium text-emerald-700 disabled:opacity-50 dark:text-emerald-400"
                  >
                    {syncing ? t("template.syncing") : t("template.sync")}
                  </button>
                )}
              </div>
            )}
            {filtered.map((x) => (
              <button
                key={x.id}
                type="button"
                onClick={() => {
                  onUpdate({ template_name: x.name, language: x.language ?? "", params: [] });
                  setOpen(false);
                }}
                className="hover:bg-muted block w-full px-2 py-1 text-left"
              >
                <div className="truncate text-[12.5px] font-medium">{x.name}</div>
                <div className="text-muted-foreground text-[10.5px]">{x.language} · {x.category}</div>
              </button>
            ))}
          </div>
        </div>
      )}
      {current && (
        <div className="bg-muted/50 rounded-md p-2 text-[12px] whitespace-pre-wrap">
          {current.header_type === "text" && current.header_content ? <div className="mb-1 font-semibold">{current.header_content}</div> : null}
          {current.body_text}
          {current.footer_text ? <div className="text-muted-foreground mt-1 text-[11px]">{current.footer_text}</div> : null}
          {current.buttons?.length ? (
            <div className="mt-1.5 flex flex-col gap-1">
              {current.buttons.map((b, i) => (
                <div key={i} className="bg-card rounded border px-2 py-0.5 text-center text-[11.5px] text-sky-700 dark:text-sky-400">{b.text}</div>
              ))}
            </div>
          ) : null}
        </div>
      )}
      {Array.from({ length: varCount }, (_, i) => (
        <div key={i}>
          <Label>{`{{${i + 1}}}`}</Label>
          <VarText value={params[i] ?? ""} onChange={(v) => onUpdate({ params: Array.from({ length: varCount }, (_, j) => (j === i ? v : params[j] ?? "")) })} vars={vars} />
        </div>
      ))}
      {mediaHeader && (
        <div>
          <Label>
            {t("template.headerMedia")} <span className="text-muted-foreground font-normal">({t("optional")})</span>
          </Label>
          <MediaPicker
            url={c.header_media_url ?? ""}
            kinds={[current!.header_type as "image" | "video" | "document"]}
            onChange={(m) => onUpdate({ header_media_url: m?.url ?? "" })}
          />
        </div>
      )}
      <p className="text-muted-foreground text-[10.5px]">{t("template.windowNote")}</p>
    </div>
  );
}
