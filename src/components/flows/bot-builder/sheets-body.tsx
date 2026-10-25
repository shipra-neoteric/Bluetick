"use client";

/**
 * Google Sheets in the Bot Builder (migration 051):
 *   - SheetPicker: paste a spreadsheet link → pick a tab → its header row
 *     is loaded (through the account's Google connection, server side);
 *   - GoogleSheetsBody: the "Google Sheets" Add Row step — one value per
 *     column, variables allowed;
 *   - SheetTriggerBody: "On New Row Google Sheet" — which tab to watch and
 *     which column holds the customer's WhatsApp number;
 *   - CtwaLeadTriggerBody: "Lead From CTWA" filters.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ExtraVariable } from "@/components/bot/variable-picker";
import { headerKeys } from "@/lib/google/sheets";
import type { BuilderNode } from "../shared";
import { Label, VarText } from "./message-bodies";

const FIELD = "border-border w-full rounded-md border bg-transparent px-2 py-1.5 text-[13px] outline-none focus:border-emerald-600";

interface GoogleStatus {
  configured?: boolean;
  available?: boolean;
  connected?: boolean;
  email?: string | null;
  error?: string | null;
}

function useGoogleStatus() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/integrations/google", { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as GoogleStatus;
        if (!cancelled) setStatus(res.ok ? json : { connected: false });
      } catch {
        if (!cancelled) setStatus({ connected: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return status;
}

export interface SheetSelection {
  spreadsheet_id?: string;
  spreadsheet_title?: string;
  sheet_name?: string;
  headers?: string[];
}

async function getJson<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    return res.ok ? { ok: true, data: json } : { ok: false, error: json.error ?? `Error ${res.status}` };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

export function SheetPicker({ value, onChange }: { value: SheetSelection; onChange: (patch: SheetSelection) => void }) {
  const t = useTranslations("BotStudio.builder.sheets");
  const status = useGoogleStatus();
  const [link, setLink] = useState(value.spreadsheet_id ? `https://docs.google.com/spreadsheets/d/${value.spreadsheet_id}` : "");
  const [tabs, setTabs] = useState<string[]>(value.sheet_name ? [value.sheet_name] : []);
  const [busy, setBusy] = useState<"tabs" | "headers" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadHeaders = async (id: string, sheet: string, meta: Partial<SheetSelection> = {}) => {
    setBusy("headers");
    setError(null);
    const r = await getJson<{ headers: string[] }>(
      `/api/integrations/google/sheets?spreadsheet=${encodeURIComponent(id)}&sheet=${encodeURIComponent(sheet)}`,
    );
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      onChange({ ...meta, spreadsheet_id: id, sheet_name: sheet, headers: [] });
      return;
    }
    if (!r.data.headers.some((h) => h.trim())) setError(t("noHeaders"));
    onChange({ ...meta, spreadsheet_id: id, sheet_name: sheet, headers: r.data.headers });
  };

  const loadTabs = async () => {
    setBusy("tabs");
    setError(null);
    const r = await getJson<{ id: string; title: string; tabs: string[] }>(
      `/api/integrations/google/sheets?spreadsheet=${encodeURIComponent(link.trim())}`,
    );
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setTabs(r.data.tabs);
    const keep = r.data.id === value.spreadsheet_id && value.sheet_name && r.data.tabs.includes(value.sheet_name);
    const sheet = keep ? value.sheet_name! : r.data.tabs[0];
    if (sheet) await loadHeaders(r.data.id, sheet, { spreadsheet_title: r.data.title });
    else onChange({ spreadsheet_id: r.data.id, spreadsheet_title: r.data.title, sheet_name: "", headers: [] });
  };

  if (status === null) {
    return (
      <p className="text-muted-foreground flex items-center gap-1 text-[12px]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("checking")}
      </p>
    );
  }
  if (status.available === false) return <p className="text-[11.5px] text-amber-600">{t("needsMigration")}</p>;
  if (!status.connected || status.error) {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-[12px] leading-snug">
        <p>{status.error ? t("reconnectNeeded") : t("notConnected")}</p>
        <Link href="/settings?tab=integrations" className="mt-1 inline-block font-medium text-emerald-700 underline dark:text-emerald-400">
          {t("openIntegrations")}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-[11px]">{t("connectedAs", { email: status.email ?? "Google" })}</p>
      <div>
        <Label>{t("spreadsheet")}</Label>
        <div className="flex gap-1">
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://docs.google.com/spreadsheets/d/…"
            aria-label={t("spreadsheet")}
            className={FIELD}
          />
          <button
            type="button"
            onClick={() => void loadTabs()}
            disabled={!link.trim() || busy !== null}
            className="shrink-0 rounded-md border border-emerald-600 px-2 text-[12px] font-medium text-emerald-700 disabled:opacity-50 dark:text-emerald-400"
          >
            {busy === "tabs" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t("load")}
          </button>
        </div>
        {value.spreadsheet_title && <p className="text-muted-foreground mt-0.5 truncate text-[11px]">{value.spreadsheet_title}</p>}
      </div>
      {value.spreadsheet_id && (
        <div>
          <Label>{t("tab")}</Label>
          <div className="flex gap-1">
            <select
              value={value.sheet_name ?? ""}
              onChange={(e) => void loadHeaders(value.spreadsheet_id!, e.target.value, { spreadsheet_title: value.spreadsheet_title })}
              disabled={busy !== null}
              aria-label={t("tab")}
              className={FIELD}
            >
              {!value.sheet_name && <option value="">{t("pickTab")}</option>}
              {tabs.map((tab) => (
                <option key={tab} value={tab}>
                  {tab}
                </option>
              ))}
            </select>
            <button
              type="button"
              title={t("refresh")}
              aria-label={t("refresh")}
              disabled={!value.sheet_name || busy !== null}
              onClick={() => void loadHeaders(value.spreadsheet_id!, value.sheet_name!, { spreadsheet_title: value.spreadsheet_title })}
              className="border-border hover:bg-muted shrink-0 rounded-md border px-2 disabled:opacity-50"
            >
              <RefreshCw className={busy === "headers" ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-[11.5px] leading-snug text-red-500">{error}</p>}
    </div>
  );
}

/** "Google Sheets" step: Add Row. */
export function GoogleSheetsBody({
  node,
  vars,
  onUpdate,
}: {
  node: BuilderNode;
  vars: ExtraVariable[];
  onUpdate: (p: Record<string, unknown>) => void;
}) {
  const t = useTranslations("BotStudio.builder.sheets");
  const c = node.config as SheetSelection & { columns?: { column: string; value: string }[] };
  const columns = c.columns ?? [];
  const headers = (c.headers ?? []).filter((h) => h.trim());
  const valueOf = (h: string) => columns.find((x) => x.column === h)?.value ?? "";
  const setValue = (h: string, v: string) => {
    const rest = columns.filter((x) => x.column !== h);
    onUpdate({ columns: v ? [...rest, { column: h, value: v }] : rest });
  };
  // Mapped columns that are no longer in the header row (renamed/removed).
  const stale = columns.filter((x) => !headers.includes(x.column));

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-muted-foreground text-[11.5px] leading-snug">{t("addRowHelp")}</p>
      <SheetPicker value={c} onChange={(p) => onUpdate(p as Record<string, unknown>)} />
      {headers.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label>{t("values")}</Label>
          {headers.map((h) => (
            <div key={h}>
              <div className="text-muted-foreground mb-0.5 text-[11.5px] font-medium">{h}</div>
              <VarText value={valueOf(h)} onChange={(v) => setValue(h, v)} vars={vars} ariaLabel={h} placeholder={t("valuePlaceholder")} />
            </div>
          ))}
        </div>
      )}
      {stale.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-[11.5px] leading-snug">
          {t("staleColumns", { columns: stale.map((s) => s.column).join(", ") })}{" "}
          <button
            type="button"
            className="font-medium underline"
            onClick={() => onUpdate({ columns: columns.filter((x) => headers.includes(x.column)) })}
          >
            {t("removeStale")}
          </button>
        </div>
      )}
      <p className="text-muted-foreground text-[10.5px]">{t("rawHint")}</p>
    </div>
  );
}

interface WatchStatus {
  last_checked_at: string | null;
  last_fired_at: string | null;
  rows_fired: number;
  last_error: string | null;
}

function useWatch(flowId: string) {
  const [watch, setWatch] = useState<WatchStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await getJson<{ watch: WatchStatus | null }>(`/api/integrations/google/watch?flow_id=${flowId}`);
      if (!cancelled && r.ok) setWatch(r.data.watch);
    })();
    return () => {
      cancelled = true;
    };
  }, [flowId]);
  return watch;
}

/** "On New Row Google Sheet" trigger settings. */
export function SheetTriggerBody({
  flowId,
  cfg,
  set,
}: {
  flowId: string;
  cfg: Record<string, unknown>;
  set: (patch: Record<string, unknown>) => void;
}) {
  const t = useTranslations("BotStudio.builder.sheets");
  const sel = cfg as SheetSelection & { phone_column?: string; name_column?: string; default_country_code?: string };
  const headers = (sel.headers ?? []).filter((h) => h.trim());
  const watch = useWatch(flowId);
  const keys = headerKeys(sel.headers ?? []);

  const pick = (field: "phone_column" | "name_column", label: string, optional: boolean) => (
    <div>
      <Label>{label}</Label>
      <select value={sel[field] ?? ""} onChange={(e) => set({ [field]: e.target.value || undefined })} aria-label={label} className={FIELD}>
        <option value="">{optional ? t("none") : t("pickColumn")}</option>
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
        {sel[field] && !headers.includes(sel[field]!) && <option value={sel[field]}>{sel[field]} ⚠</option>}
      </select>
    </div>
  );

  return (
    <div className="flex flex-col gap-2.5">
      <SheetPicker
        value={sel}
        onChange={(p) => {
          // Guess the phone column the first time headers arrive.
          const guess =
            !sel.phone_column && p.headers ? p.headers.find((h) => /phone|mobile|whatsapp|number|contact/i.test(h)) : undefined;
          set({ ...p, ...(guess ? { phone_column: guess } : {}) });
        }}
      />
      {headers.length > 0 && (
        <>
          {pick("phone_column", t("phoneColumn"), false)}
          {pick("name_column", t("nameColumn"), true)}
          <div>
            <Label>{t("countryCode")}</Label>
            <input
              value={sel.default_country_code ?? ""}
              onChange={(e) => set({ default_country_code: e.target.value.replace(/\D/g, "").slice(0, 4) })}
              placeholder="91"
              inputMode="numeric"
              aria-label={t("countryCode")}
              className={FIELD}
            />
            <p className="text-muted-foreground mt-0.5 text-[10.5px]">{t("countryCodeHint")}</p>
          </div>
          <div className="text-muted-foreground text-[11px] leading-snug">
            <div className="mb-0.5 font-medium">{t("rowVariables")}</div>
            <div className="flex flex-wrap gap-1">
              {keys
                .filter((_, i) => (sel.headers ?? [])[i]?.trim())
                .map((k) => (
                  <code key={k} className="bg-muted rounded px-1 text-[10.5px]">{`{{trigger.row.${k}}}`}</code>
                ))}
            </div>
          </div>
        </>
      )}
      <p className="text-muted-foreground text-[11px] leading-snug">{t("pollHint")}</p>
      {watch && (
        <div className="border-border rounded-md border p-2 text-[11px] leading-snug">
          <div>
            {t("lastChecked")}: {watch.last_checked_at ? new Date(watch.last_checked_at).toLocaleString() : "—"}
          </div>
          <div>
            {t("rowsStarted")}: {watch.rows_fired}
          </div>
          {watch.last_error && <div className="text-red-500">{watch.last_error}</div>}
        </div>
      )}
    </div>
  );
}

/** "Lead From CTWA" trigger settings. */
export function CtwaLeadTriggerBody({ cfg, set }: { cfg: Record<string, unknown>; set: (patch: Record<string, unknown>) => void }) {
  const t = useTranslations("BotStudio.builder.ctwaLead");
  const ids = Array.isArray(cfg.source_ids) ? (cfg.source_ids as string[]) : [];
  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <Label>{t("mode")}</Label>
        <select
          value={cfg.lead_mode === "new_ad" ? "new_ad" : "new_contact"}
          onChange={(e) => set({ lead_mode: e.target.value })}
          aria-label={t("mode")}
          className={FIELD}
        >
          <option value="new_contact">{t("modes.new_contact")}</option>
          <option value="new_ad">{t("modes.new_ad")}</option>
        </select>
      </div>
      <div>
        <Label>{t("adIds")}</Label>
        <input
          defaultValue={ids.join(", ")}
          onBlur={(e) =>
            set({
              source_ids: e.target.value
                .split(/[,\s]+/)
                .map((s) => s.trim())
                .filter(Boolean)
                .slice(0, 50),
            })
          }
          placeholder={t("anyAd")}
          aria-label={t("adIds")}
          className={FIELD}
        />
        <p className="text-muted-foreground mt-0.5 text-[10.5px]">{t("adIdsHint")}</p>
      </div>
      <div className="text-muted-foreground text-[11px] leading-snug">
        <div className="mb-0.5 font-medium">{t("variables")}</div>
        <div className="flex flex-wrap gap-1">
          {["headline", "source_id", "source_url", "body", "source_type"].map((k) => (
            <code key={k} className="bg-muted rounded px-1 text-[10.5px]">{`{{trigger.${k}}}`}</code>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Variables a flow's trigger provides, for the {} pickers. */
export function triggerVariables(type: string, cfg: Record<string, unknown>): ExtraVariable[] {
  if (type === "google_sheet_new_row") {
    const headers = Array.isArray(cfg.headers) ? (cfg.headers as string[]) : [];
    const keys = headerKeys(headers);
    return [
      ...keys.filter((_, i) => headers[i]?.trim()).map((k, i) => ({ token: `trigger.row.${k}`, label: headers.filter((h) => h.trim())[i] })),
      { token: "trigger.row_number" },
    ];
  }
  if (type === "ctwa_lead" || type === "ctwa_message") {
    return ["headline", "source_id", "source_url", "body"].map((k) => ({ token: `trigger.${k}` }));
  }
  return [];
}
