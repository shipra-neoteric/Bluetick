"use client";

/**
 * Bodies for the message cards:
 *   - Send Message (A05): optional attachment (Upload or Enter url), body
 *     with {} variables and counter, and an explicit "On response".
 *   - Send Interactive Message (A03): Header None / Text / Media, body,
 *     footer, quick-reply buttons (each with its own connection dot) and
 *     an "Any other reply" output.
 *   - Send Interactive List Message (A02): header, body, footer, list
 *     button, sections and items (each item with its own dot), reorder,
 *     item description, and "Any other reply".
 * Limits are WhatsApp's (header 60, body 1024, footer 60, button 20,
 * row title 24, row description 72, 3 buttons, 10 rows).
 */

import { useRef, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { ArrowDown, ArrowUp, Loader2, MoreVertical, Plus, Trash2, Upload, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { MEDIA_MAX_BYTES, uploadAccountMedia } from "@/lib/storage/upload-media";
import { VariablePicker, type ExtraVariable } from "@/components/bot/variable-picker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { BuilderNode } from "../shared";

export const LIMITS = { header: 60, body: 1024, text: 4096, footer: 60, button: 20, listButton: 20, rowTitle: 24, rowDesc: 72, sectionTitle: 24, buttons: 3, rows: 10 };
const FIELD = "border-border w-full rounded-md border bg-transparent px-2 py-1.5 text-[13px] outline-none focus:border-emerald-600";
const HANDLE = "!h-2.5 !w-2.5 !border-0 !bg-emerald-600";

export function Count({ n, max }: { n: number; max: number }) {
  return <div className={cn("mt-0.5 text-right text-[10px]", n > max ? "text-red-500" : "text-muted-foreground")}>({n}/{max})</div>;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1 text-[12px] font-medium">{children}</div>;
}

/** Text field with the {} variable button and a character counter. */
export function VarText({
  value,
  onChange,
  max,
  vars,
  placeholder,
  rows,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  max?: number;
  vars: ExtraVariable[];
  placeholder?: string;
  rows?: number;
  ariaLabel?: string;
}) {
  return (
    <div>
      <div className="relative">
        {rows ? (
          <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={rows} placeholder={placeholder} aria-label={ariaLabel} className={cn(FIELD, "resize-y pr-9")} />
        ) : (
          <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={ariaLabel} className={cn(FIELD, "pr-9")} />
        )}
        <div className="absolute right-1 bottom-1">
          <VariablePicker extra={vars} onInsert={(tok) => onChange(`${value}${tok}`)} />
        </div>
      </div>
      {max ? <Count n={value.length} max={max} /> : null}
    </div>
  );
}

type MediaKind = "image" | "video" | "document" | "audio";
const kindOf = (mime: string): MediaKind =>
  mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "document";

/** "Upload image, audio, video or PDF" — Upload or Enter url. */
export function MediaPicker({
  url,
  filename,
  kinds,
  onChange,
}: {
  url: string;
  filename?: string;
  kinds: MediaKind[];
  onChange: (m: { url: string; type?: MediaKind; filename?: string } | null) => void;
}) {
  const t = useTranslations("BotStudio.builder");
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const accept = kinds.map((k) => (k === "document" ? "application/pdf" : `${k}/*`)).join(",");

  const upload = async (f: File) => {
    if (f.size > MEDIA_MAX_BYTES) {
      toast.error(t("media.tooBig"));
      return;
    }
    const type = kindOf(f.type);
    if (!kinds.includes(type)) {
      toast.error(t("media.wrongType"));
      return;
    }
    setBusy(true);
    try {
      const { publicUrl } = await uploadAccountMedia("flow-media", f);
      onChange({ url: publicUrl, type, filename: f.name });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("media.uploadFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (url) {
    return (
      <div className="border-border flex items-center gap-2 rounded-md border px-2 py-1.5 text-[12px]">
        <span className="min-w-0 flex-1 truncate" title={url}>{filename || url}</span>
        <button type="button" onClick={() => onChange(null)} aria-label={t("media.remove")} className="text-muted-foreground hover:text-red-500">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }
  return (
    <div>
      <div className="mb-1 text-[12px] font-medium">{t(kinds.includes("audio") ? "media.labelAll" : "media.labelHeader")}</div>
      <div className="flex items-center gap-2 text-[12px]">
        <input ref={file} type="file" accept={accept} className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
        <button type="button" disabled={busy} onClick={() => file.current?.click()} className="border-border hover:bg-muted inline-flex items-center gap-1 rounded-md border px-2 py-1">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {t("media.upload")}
        </button>
        <span className="text-muted-foreground">{t("media.or")}</span>
        <button type="button" onClick={() => setTyping((v) => !v)} className="text-emerald-700 underline dark:text-emerald-400">
          {t("media.enterUrl")}
        </button>
      </div>
      {typing && (
        <input
          autoFocus
          placeholder="https://…"
          className={cn(FIELD, "mt-1.5")}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const v = (e.target as HTMLInputElement).value.trim();
            if (!/^https:\/\//i.test(v)) {
              toast.error(t("media.httpsOnly"));
              return;
            }
            const ext = v.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
            const type: MediaKind = ["jpg", "jpeg", "png", "webp"].includes(ext) ? "image" : ["mp4", "3gp"].includes(ext) ? "video" : ["mp3", "ogg", "aac", "m4a", "amr"].includes(ext) ? "audio" : "document";
            onChange({ url: v, type: kinds.includes(type) ? type : kinds[0] });
            setTyping(false);
          }}
        />
      )}
    </div>
  );
}

// ── Send Message ─────────────────────────────────────────────────────

export function MessageBody({ node, vars, onUpdate }: { node: BuilderNode; vars: ExtraVariable[]; onUpdate: (p: Record<string, unknown>) => void }) {
  const t = useTranslations("BotStudio.builder");
  const c = node.config as { text?: string; media_url?: string; filename?: string; wait_reply?: boolean; reply_var?: string };
  const text = c.text ?? "";
  return (
    <div className="flex flex-col gap-2">
      <MediaPicker
        url={c.media_url ?? ""}
        filename={c.filename}
        kinds={["image", "video", "audio", "document"]}
        onChange={(m) => onUpdate(m ? { media_url: m.url, media_type: m.type, filename: m.filename } : { media_url: undefined, media_type: undefined, filename: undefined })}
      />
      <div>
        <Label>{t("body")}</Label>
        <VarText value={text} onChange={(v) => onUpdate({ text: v })} rows={4} max={c.media_url ? LIMITS.body : LIMITS.text} vars={vars} placeholder={t("bodyPlaceholder")} />
      </div>
      <label className="flex items-center gap-2 text-[12.5px]">
        <input type="checkbox" className="accent-emerald-600" checked={Boolean(c.wait_reply)} onChange={(e) => onUpdate({ wait_reply: e.target.checked })} />
        {t("onResponse")}
      </label>
      {c.wait_reply && (
        <div>
          <Label>{t("saveReplyAs")}</Label>
          <input value={c.reply_var ?? ""} onChange={(e) => onUpdate({ reply_var: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })} placeholder="answer" className={FIELD} />
          <p className="text-muted-foreground mt-0.5 text-[10.5px]">{t("onResponseHint")}</p>
        </div>
      )}
    </div>
  );
}

// ── Send Interactive Message (buttons) ──────────────────────────────

interface Btn {
  reply_id: string;
  title: string;
  next_node_key: string;
}

function nextId(prefix: string, used: Set<string>, start: number) {
  let i = start;
  while (used.has(`${prefix}_${i}`)) i++;
  return `${prefix}_${i}`;
}

function OtherReply() {
  const t = useTranslations("BotStudio.builder");
  return (
    <div className="text-muted-foreground relative mt-1 flex items-center justify-end pr-1 text-[11.5px]">
      {t("anyOtherReply")}
      <Handle type="source" id="other" position={Position.Right} className={cn(HANDLE, "!-right-[17px]")} />
    </div>
  );
}

export function InteractiveBody({ node, vars, onUpdate }: { node: BuilderNode; vars: ExtraVariable[]; onUpdate: (p: Record<string, unknown>) => void }) {
  const t = useTranslations("BotStudio.builder");
  const cfg = node.config as { text?: string; header_text?: string; header_media_url?: string; header_media_type?: string; footer_text?: string; buttons?: Btn[] };
  const buttons = cfg.buttons ?? [];
  const header: "none" | "text" | "media" = cfg.header_media_url !== undefined ? "media" : cfg.header_text !== undefined ? "text" : "none";

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Label>
          {t("header")} <span className="text-muted-foreground font-normal">({t("optional")})</span>
        </Label>
        <div className="flex gap-1.5">
          {(["none", "text", "media"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() =>
                onUpdate(
                  k === "none"
                    ? { header_text: undefined, header_media_url: undefined, header_media_type: undefined }
                    : k === "text"
                      ? { header_text: cfg.header_text ?? "", header_media_url: undefined, header_media_type: undefined }
                      : { header_text: undefined, header_media_url: cfg.header_media_url ?? "" },
                )
              }
              className={cn("rounded-full border px-3 py-1 text-[12px] font-medium", header === k ? "border-emerald-700 bg-emerald-700 text-white" : "border-border hover:bg-muted")}
            >
              {t(k === "none" ? "headerNone" : k === "text" ? "headerText" : "headerMedia")}
            </button>
          ))}
        </div>
        {header === "text" && (
          <div className="mt-1.5">
            <VarText value={cfg.header_text ?? ""} onChange={(v) => onUpdate({ header_text: v })} max={LIMITS.header} vars={vars} placeholder={t("headerPlaceholder")} />
          </div>
        )}
        {header === "media" && (
          <div className="mt-1.5">
            <MediaPicker
              url={cfg.header_media_url ?? ""}
              kinds={["image", "video", "document"]}
              onChange={(m) => onUpdate(m ? { header_media_url: m.url, header_media_type: m.type } : { header_media_url: "", header_media_type: undefined })}
            />
          </div>
        )}
      </div>
      <div>
        <Label>{t("body")}</Label>
        <VarText value={cfg.text ?? ""} onChange={(v) => onUpdate({ text: v })} rows={4} max={LIMITS.body} vars={vars} placeholder={t("bodyPlaceholder")} />
      </div>
      <div>
        <Label>{t("footer")}</Label>
        <VarText value={cfg.footer_text ?? ""} onChange={(v) => onUpdate({ footer_text: v })} max={LIMITS.footer} vars={vars} placeholder={t("footerPlaceholder")} />
      </div>
      <div>
        <Label>{t("quickReplies")}</Label>
        <div className="border-border flex flex-col gap-1.5 rounded-md border p-1.5">
          {buttons.map((b, i) => (
            <div key={b.reply_id || i}>
              <div className="relative flex items-center gap-1 rounded-md border border-emerald-600/40 bg-emerald-600/5 px-2 py-1.5">
                <input
                  value={b.title}
                  maxLength={LIMITS.button}
                  onChange={(e) => onUpdate({ buttons: buttons.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })}
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-emerald-800 outline-none dark:text-emerald-300"
                  aria-label={t("buttonTitle")}
                />
                <VariablePicker extra={vars} onInsert={(tok) => onUpdate({ buttons: buttons.map((x, j) => (j === i ? { ...x, title: `${x.title}${tok}` } : x)) })} />
                <button type="button" onClick={() => onUpdate({ buttons: buttons.filter((_, j) => j !== i) })} aria-label={t("removeButton")} className="text-muted-foreground hover:text-red-500">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                {b.reply_id && <Handle type="source" id={`button:${b.reply_id}`} position={Position.Right} className={cn(HANDLE, "!-right-[19px]")} />}
              </div>
              <Count n={b.title.length} max={LIMITS.button} />
            </div>
          ))}
          {buttons.length < LIMITS.buttons && (
            <button
              type="button"
              onClick={() =>
                onUpdate({ buttons: [...buttons, { reply_id: nextId("btn", new Set(buttons.map((b) => b.reply_id)), buttons.length + 1), title: t("newButton"), next_node_key: "" }] })
              }
              className="rounded-md border border-emerald-600 py-1.5 text-[13px] font-medium text-emerald-700 hover:bg-emerald-600/5 dark:text-emerald-400"
            >
              {t("addButton")}
            </button>
          )}
        </div>
        <OtherReply />
      </div>
    </div>
  );
}

// ── Send Interactive List Message ───────────────────────────────────

interface Row {
  reply_id: string;
  title: string;
  description?: string;
  next_node_key: string;
}
interface Section {
  title?: string;
  rows: Row[];
}

export function ListBody({ node, vars, onUpdate }: { node: BuilderNode; vars: ExtraVariable[]; onUpdate: (p: Record<string, unknown>) => void }) {
  const t = useTranslations("BotStudio.builder");
  const cfg = node.config as { text?: string; header_text?: string; footer_text?: string; button_label?: string; sections?: Section[] };
  const sections = cfg.sections?.length ? cfg.sections : [{ title: "", rows: [] }];
  const total = sections.reduce((n, s) => n + s.rows.length, 0);
  const used = new Set(sections.flatMap((s) => s.rows.map((r) => r.reply_id)));
  const [editing, setEditing] = useState<string | null>(null);

  const setSections = (next: Section[]) => onUpdate({ sections: next });
  const setRow = (si: number, ri: number, patch: Partial<Row>) =>
    setSections(sections.map((s, i) => (i !== si ? s : { ...s, rows: s.rows.map((r, j) => (j === ri ? { ...r, ...patch } : r)) })));
  const moveRow = (si: number, ri: number, dir: -1 | 1) => {
    const rows = [...sections[si].rows];
    const to = ri + dir;
    if (to < 0 || to >= rows.length) return;
    [rows[ri], rows[to]] = [rows[to], rows[ri]];
    setSections(sections.map((s, i) => (i === si ? { ...s, rows } : s)));
  };

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Label>
          {t("header")} <span className="text-muted-foreground font-normal">({t("optional")})</span>
        </Label>
        <VarText value={cfg.header_text ?? ""} onChange={(v) => onUpdate({ header_text: v })} max={LIMITS.header} vars={vars} placeholder={t("headerPlaceholder")} />
      </div>
      <div>
        <Label>{t("body")}</Label>
        <VarText value={cfg.text ?? ""} onChange={(v) => onUpdate({ text: v })} rows={3} max={LIMITS.body} vars={vars} placeholder={t("bodyPlaceholder")} />
      </div>
      <div>
        <Label>{t("footer")}</Label>
        <VarText value={cfg.footer_text ?? ""} onChange={(v) => onUpdate({ footer_text: v })} max={LIMITS.footer} vars={vars} placeholder={t("footerPlaceholder")} />
      </div>
      <div>
        <Label>{t("listButton")}</Label>
        <VarText value={cfg.button_label ?? ""} onChange={(v) => onUpdate({ button_label: v })} max={LIMITS.listButton} vars={vars} placeholder={t("listButtonPlaceholder")} />
      </div>
      {sections.map((s, si) => (
        <div key={si} className="border-border rounded-md border p-1.5">
          <div className="flex items-center gap-1">
            <input
              value={s.title ?? ""}
              maxLength={LIMITS.sectionTitle}
              onChange={(e) => setSections(sections.map((x, i) => (i === si ? { ...x, title: e.target.value } : x)))}
              placeholder={t("sectionTitle")}
              aria-label={t("sectionTitle")}
              className={cn(FIELD, "font-medium")}
            />
            {sections.length > 1 && (
              <button type="button" onClick={() => setSections(sections.filter((_, i) => i !== si))} aria-label={t("removeSection")} className="text-muted-foreground hover:text-red-500">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {s.rows.map((r, ri) => (
              <div key={r.reply_id || ri}>
                <div className="relative flex items-center gap-1 rounded-md border border-emerald-600/40 bg-emerald-600/5 px-2 py-1.5">
                  <input
                    value={r.title}
                    maxLength={LIMITS.rowTitle}
                    onChange={(e) => setRow(si, ri, { title: e.target.value })}
                    className="min-w-0 flex-1 bg-transparent text-[13px] text-emerald-800 outline-none dark:text-emerald-300"
                    aria-label={t("itemTitle")}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger aria-label={t("itemMenu")} className="text-muted-foreground hover:text-foreground rounded p-0.5">
                      <MoreVertical className="h-3.5 w-3.5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem onClick={() => setEditing(editing === r.reply_id ? null : r.reply_id)}>{t("editDescription")}</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => moveRow(si, ri, -1)} disabled={ri === 0}>
                        <ArrowUp className="h-3.5 w-3.5" /> {t("moveUp")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => moveRow(si, ri, 1)} disabled={ri === s.rows.length - 1}>
                        <ArrowDown className="h-3.5 w-3.5" /> {t("moveDown")}
                      </DropdownMenuItem>
                      <DropdownMenuItem className="text-red-500" onClick={() => setSections(sections.map((x, i) => (i === si ? { ...x, rows: x.rows.filter((_, j) => j !== ri) } : x)))}>
                        <Trash2 className="h-3.5 w-3.5" /> {t("delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {r.reply_id && <Handle type="source" id={`row:${r.reply_id}`} position={Position.Right} className={cn(HANDLE, "!-right-[25px]")} />}
                </div>
                <Count n={r.title.length} max={LIMITS.rowTitle} />
                {(editing === r.reply_id || r.description) && (
                  <div>
                    <input
                      value={r.description ?? ""}
                      maxLength={LIMITS.rowDesc}
                      onChange={(e) => setRow(si, ri, { description: e.target.value })}
                      placeholder={t("itemDescription")}
                      className={cn(FIELD, "text-[12px]")}
                    />
                    <Count n={(r.description ?? "").length} max={LIMITS.rowDesc} />
                  </div>
                )}
              </div>
            ))}
            {total < LIMITS.rows && (
              <button
                type="button"
                onClick={() =>
                  setSections(
                    sections.map((x, i) =>
                      i === si ? { ...x, rows: [...x.rows, { reply_id: nextId("row", used, total + 1), title: t("newItem"), next_node_key: "" }] } : x,
                    ),
                  )
                }
                className="inline-flex items-center justify-center gap-1 rounded-md border border-emerald-600 py-1 text-[12.5px] font-medium text-emerald-700 hover:bg-emerald-600/5 dark:text-emerald-400"
              >
                <Plus className="h-3.5 w-3.5" /> {t("addItem")}
              </button>
            )}
          </div>
        </div>
      ))}
      {total < LIMITS.rows && (
        <button
          type="button"
          onClick={() => setSections([...sections, { title: "", rows: [{ reply_id: nextId("row", used, total + 1), title: t("newItem"), next_node_key: "" }] }])}
          className="border-border hover:bg-muted rounded-md border border-dashed py-1.5 text-[12.5px] font-medium"
        >
          {t("addSection")}
        </button>
      )}
      <p className="text-muted-foreground text-[10.5px]">{t("rowsLeft", { count: LIMITS.rows - total })}</p>
      <OtherReply />
    </div>
  );
}
