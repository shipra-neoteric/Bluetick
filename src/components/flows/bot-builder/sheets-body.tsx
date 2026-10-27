"use client";

/**
 * Google Sheets in the Bot Builder (migrations 051 + 053):
 *   - SheetPicker: pick one of the account's Google accounts (or sign in
 *     with another one in a popup, right here) → pick a spreadsheet from
 *     the ones that Google account can see → pick a tab → its header row
 *     is loaded (server side, through that Google account);
 *   - GoogleSheetsBody: the "Google Sheets" Add Row step — one value per
 *     column, variables allowed;
 *   - SheetTriggerBody: "On New Row Google Sheet" — which tab to watch and
 *     which column identifies the customer (phone, else username / BSUID,
 *     else Bluetick customer ID);
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ExternalLink, Loader2, RefreshCw, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ExtraVariable } from "@/components/bot/variable-picker";
import { columnLetter, headerKeys, headerProblems, letterHeaders, parseSpreadsheetId } from "@/lib/google/sheets";
import { GOOGLE_CONNECTED_MESSAGE, GOOGLE_FAILED_MESSAGE, GOOGLE_POPUP_CHANNEL } from "@/lib/google/popup";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { BuilderNode } from "../shared";
import { Label, VarText } from "./message-bodies";

const FIELD = "border-border w-full rounded-md border bg-transparent px-2 py-1.5 text-[13px] outline-none focus:border-emerald-600";
const LINK = "inline-flex items-center gap-0.5 text-emerald-700 hover:underline dark:text-emerald-400";
const POLICY_URL = "https://developers.google.com/terms/api-services-user-data-policy";

interface GoogleAccount {
  id: string;
  email: string | null;
  connected_at: string;
  error: string | null;
  /** false: connected before spreadsheet listing existed (sign in again). */
  can_list?: boolean;
}

interface GoogleStatus {
  configured?: boolean;
  available?: boolean;
  accounts?: GoogleAccount[];
}

function useGoogleAccounts() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/integrations/google", { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as GoogleStatus;
        if (!cancelled) setStatus(res.ok ? json : { accounts: [] });
      } catch {
        if (!cancelled) setStatus({ accounts: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);
  return { status, reload };
}

/**
 * "Sign in with Google" in a popup: Google's consent screen, then the
 * callback page tells this window (postMessage, or a BroadcastChannel when
 * the browser cut the opener link) and closes. Only the picker that opened
 * the popup reacts.
 */
function useGoogleSignIn(onDone: (r: { id: string } | { failed: string }) => void) {
  const pending = useRef(false);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const handle = (data: unknown) => {
      if (!pending.current || !data || typeof data !== "object") return;
      const m = data as { type?: string; id?: string; result?: string };
      if (m.type === GOOGLE_CONNECTED_MESSAGE && typeof m.id === "string") {
        pending.current = false;
        done.current({ id: m.id });
      } else if (m.type === GOOGLE_FAILED_MESSAGE) {
        pending.current = false;
        done.current({ failed: String(m.result ?? "error") });
      }
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin === window.location.origin) handle(e.data);
    };
    window.addEventListener("message", onMessage);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(GOOGLE_POPUP_CHANNEL);
      channel.onmessage = (e) => handle(e.data);
    } catch {
      channel = null;
    }
    return () => {
      window.removeEventListener("message", onMessage);
      channel?.close();
    };
  }, []);

  /** false when the browser blocked the popup. */
  return useCallback(() => {
    const w = 520;
    const h = 680;
    const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
    const top = Math.max(0, window.screenY + (window.outerHeight - h) / 2);
    const popup = window.open(
      "/api/integrations/google/connect?popup=1",
      "bluetick-google-signin",
      `popup=yes,width=${w},height=${h},left=${left},top=${top}`,
    );
    if (!popup) return false;
    pending.current = true;
    popup.focus();
    return true;
  }, []);
}

/** Google's branded sign-in button (white, "G" logo). */
function GoogleButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative flex h-10 w-full items-center justify-center rounded-md border border-[#dadce0] bg-white px-10 text-[13.5px] font-medium text-[#3c4043] shadow-sm hover:bg-[#f8faff]"
    >
      <svg aria-hidden viewBox="0 0 48 48" className="absolute left-3 h-5 w-5">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      </svg>
      {label}
    </button>
  );
}

interface Option {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Small searchable dropdown. The list opens in place (not floating), so
 * it is never clipped by the card. `onSearch` = server-side search
 * (debounced); otherwise options are filtered here.
 */
function Combobox({
  value,
  selectedLabel,
  placeholder,
  options,
  loading,
  error,
  onOpen,
  onSearch,
  onSelect,
  disabled,
  ariaLabel,
}: {
  value: string;
  selectedLabel?: string;
  placeholder: string;
  options: Option[];
  loading?: boolean;
  error?: string | null;
  onOpen?: () => void;
  onSearch?: (q: string) => void;
  onSelect: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  const t = useTranslations("BotStudio.builder.sheets");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (!open || !onSearch) return;
    const id = setTimeout(() => onSearch(q.trim()), 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounce on the query only
  }, [q, open]);

  const needle = q.trim().toLowerCase();
  const shown = onSearch || !needle ? options : options.filter((o) => o.label.toLowerCase().includes(needle));
  const label = selectedLabel ?? options.find((o) => o.value === value)?.label;

  return (
    <div ref={box} className="min-w-0 flex-1">
      <button
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
        className={`${FIELD} flex items-center justify-between gap-1 text-left disabled:opacity-50`}
      >
        <span className={label ? "truncate" : "text-muted-foreground truncate"}>{label || placeholder}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </button>
      {open && (
        <div className="border-border bg-background mt-1 rounded-md border shadow-sm">
          <div className="border-border flex items-center gap-1 border-b px-2">
            <Search className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
              placeholder={t("search")}
              aria-label={t("search")}
              className="w-full bg-transparent py-1.5 text-[12.5px] outline-none"
            />
            {loading && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
          </div>
          <ul role="listbox" className="max-h-56 overflow-y-auto py-1">
            {shown.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  onClick={() => {
                    setOpen(false);
                    setQ("");
                    onSelect(o.value);
                  }}
                  className={`hover:bg-muted flex w-full flex-col px-2 py-1 text-left text-[12.5px] ${o.value === value ? "font-semibold" : ""}`}
                >
                  <span className="truncate">{o.label}</span>
                  {o.hint && <span className="text-muted-foreground truncate text-[10.5px]">{o.hint}</span>}
                </button>
              </li>
            ))}
            {!loading && !error && shown.length === 0 && <li className="text-muted-foreground px-2 py-1 text-[12px]">{t("noResults")}</li>}
            {error && <li className="px-2 py-1 text-[11.5px] leading-snug text-red-500">{error}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

export interface SheetSelection {
  /** Which of the account's Google connections to use (migration 053). */
  google_connection_id?: string;
  spreadsheet_id?: string;
  spreadsheet_title?: string;
  sheet_name?: string;
  /** Google's stable sheetId of the tab (a renamed tab keeps working). */
  sheet_id?: number;
  /** Trigger only: false = row 1 is data, columns are "Column A", … */
  first_row_header?: boolean;
  headers?: string[];
}

interface Tab {
  id: number;
  title: string;
}

interface SpreadsheetFile {
  id: string;
  name: string;
  modifiedTime: string | null;
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

const sheetsApi = (connection: string | undefined, id: string, sheet?: string, preview?: boolean) =>
  `/api/integrations/google/sheets?spreadsheet=${encodeURIComponent(id)}` +
  (connection ? `&connection=${encodeURIComponent(connection)}` : "") +
  (sheet ? `&sheet=${encodeURIComponent(sheet)}` : "") +
  (preview ? "&preview=1" : "");

/** Cleared whenever the Google account or the spreadsheet changes. */
const NO_SHEET: SheetSelection = { spreadsheet_id: "", spreadsheet_title: "", sheet_name: "", sheet_id: undefined, headers: [] };

/**
 * Google account → spreadsheet → tab; loads the header row. Loading,
 * refreshing and previewing only read the sheet: nothing is imported or
 * sent. `headerToggle` (trigger) offers "Use first row as header";
 * `intro` is shown until a Google account is chosen.
 */
export function SheetPicker({
  value,
  onChange,
  headerToggle = false,
  intro,
}: {
  value: SheetSelection;
  onChange: (patch: SheetSelection) => void;
  headerToggle?: boolean;
  intro?: string;
}) {
  const t = useTranslations("BotStudio.builder.sheets");
  const { status, reload } = useGoogleAccounts();
  const [changing, setChanging] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [files, setFiles] = useState<SpreadsheetFile[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [tabs, setTabs] = useState<Tab[]>(value.sheet_name ? [{ id: value.sheet_id ?? -1, title: value.sheet_name }] : []);
  const [tabsLoaded, setTabsLoaded] = useState(false);
  const [busy, setBusy] = useState<"files" | "tabs" | "headers" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[][] | null>(null);
  const useHeader = !headerToggle || value.first_row_header !== false;

  const accounts = status?.accounts ?? [];
  // Flows saved before 053 have no account id: they use the oldest one.
  const connectionId = value.google_connection_id || (value.spreadsheet_id ? accounts[0]?.id : undefined);
  const account = accounts.find((a) => a.id === connectionId);
  const chosen = Boolean(account) && !changing;

  const chooseAccount = (id: string) => {
    setChanging(false);
    setSignInError(null);
    if (id === connectionId) return;
    // Another Google account sees other files: start the sheet over.
    setFiles(null);
    setTabs([]);
    setTabsLoaded(false);
    setError(null);
    onChange({ ...NO_SHEET, google_connection_id: id });
  };

  const signIn = useGoogleSignIn((r) => {
    reload();
    if ("id" in r) chooseAccount(r.id);
    else setSignInError(t("signInFailed"));
  });

  const loadFiles = async (q = "") => {
    if (!connectionId) return;
    setBusy("files");
    setFilesError(null);
    const r = await getJson<{ files: SpreadsheetFile[] }>(
      `/api/integrations/google/spreadsheets?connection=${encodeURIComponent(connectionId)}&q=${encodeURIComponent(q)}`,
    );
    setBusy(null);
    if (!r.ok) {
      setFilesError(r.error);
      setFiles([]);
      return;
    }
    setFiles(r.data.files);
  };

  const loadHeaders = async (id: string, tab: Tab, extra: Partial<SheetSelection> = {}, withHeader = useHeader) => {
    setBusy("headers");
    setError(null);
    const base = {
      ...extra,
      google_connection_id: connectionId,
      spreadsheet_id: id,
      sheet_name: tab.title,
      ...(tab.id >= 0 ? { sheet_id: tab.id } : {}),
    };
    if (!withHeader) {
      // Row 1 is data: columns are named by letter, as wide as the data.
      const r = await getJson<{ rows: string[][] }>(sheetsApi(connectionId, id, tab.title, true));
      setBusy(null);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const width = Math.max(1, ...r.data.rows.map((row) => row.length));
      onChange({ ...base, headers: letterHeaders(width) });
      return;
    }
    const r = await getJson<{ headers: string[] }>(sheetsApi(connectionId, id, tab.title));
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      onChange({ ...base, headers: [] });
      return;
    }
    if (!r.data.headers.some((h) => h.trim())) setError(t("noHeaders"));
    onChange({ ...base, headers: r.data.headers });
  };

  /** Tabs of a spreadsheet. `pick` = a newly chosen file (not a refresh). */
  const loadTabs = async (id: string, pick: boolean) => {
    setBusy("tabs");
    setError(null);
    const r = await getJson<{ id: string; title: string; tabs: string[]; sheets?: Tab[] }>(sheetsApi(connectionId, id));
    setBusy(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    const list: Tab[] = r.data.sheets ?? r.data.tabs.map((title) => ({ id: -1, title }));
    setTabs(list);
    setTabsLoaded(true);
    if (pick) {
      // A single tab is picked for you; otherwise "Select a sheet".
      if (list.length === 1) await loadHeaders(r.data.id, list[0], { spreadsheet_title: r.data.title });
      else onChange({ ...NO_SHEET, google_connection_id: connectionId, spreadsheet_id: r.data.id, spreadsheet_title: r.data.title });
      return;
    }
    // Refresh: keep the chosen tab when it still exists (by id, else title).
    const keep = list.find((x) => (value.sheet_id !== undefined && x.id === value.sheet_id) || x.title === value.sheet_name);
    if (keep) await loadHeaders(r.data.id, keep, { spreadsheet_title: r.data.title });
    else onChange({ ...NO_SHEET, google_connection_id: connectionId, spreadsheet_id: r.data.id, spreadsheet_title: r.data.title });
  };

  const openPreview = async () => {
    if (!value.spreadsheet_id || !value.sheet_name) return;
    setPreview([]);
    const r = await getJson<{ rows: string[][] }>(sheetsApi(connectionId, value.spreadsheet_id, value.sheet_name, true));
    if (!r.ok) {
      setPreview(null);
      setError(r.error);
      return;
    }
    setPreview(r.data.rows);
  };

  if (status === null) {
    return (
      <p className="text-muted-foreground flex items-center gap-1 text-[12px]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("checking")}
      </p>
    );
  }
  if (status.available === false) return <p className="text-[11.5px] text-amber-600">{t("needsMigration")}</p>;

  const startSignIn = () => {
    setSignInError(null);
    if (!signIn()) setSignInError(t("popupBlocked"));
  };
  const signInBlock = (
    <div className="flex flex-col items-stretch gap-1">
      {status.configured === false ? (
        <p className="text-[11.5px] leading-snug text-amber-600">{t("notConfigured")}</p>
      ) : (
        <GoogleButton onClick={startSignIn} label={t("signInWithGoogle")} />
      )}
      <a href={POLICY_URL} target="_blank" rel="noopener noreferrer" className="self-start text-[11px] text-blue-600 underline dark:text-blue-400">
        {t("userDataPolicy")}
      </a>
      {signInError && <p className="text-[11.5px] leading-snug text-red-500">{signInError}</p>}
    </div>
  );

  // 1. Choose (or add) the Google account.
  if (!chosen) {
    return (
      <div className="flex flex-col gap-2">
        {intro && <p className="text-muted-foreground text-[11.5px] leading-snug">{intro}</p>}
        {/* Every Google account added to this workspace (here or in
            Settings → Integrations); signing in below adds another. */}
        <select
          value={account?.id ?? ""}
          onChange={(e) => e.target.value && chooseAccount(e.target.value)}
          aria-label={t("selectAccount")}
          className={`${FIELD} h-10 text-[14px]`}
        >
          <option value="">{t("selectAccount")}</option>
          {accounts.length === 0 && (
            <option value="" disabled>
              {t("noAccountsYet")}
            </option>
          )}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {(a.email ?? "Google") + (a.error ? ` — ${t("needsReconnect")}` : "")}
            </option>
          ))}
        </select>
        {signInBlock}
        {changing && account && (
          <button type="button" onClick={() => setChanging(false)} className="text-muted-foreground self-start text-[11.5px] underline">
            {t("cancel")}
          </button>
        )}
      </div>
    );
  }

  const currentTab = tabs.find((x) => (value.sheet_id !== undefined && x.id === value.sheet_id) || x.title === value.sheet_name);
  const problems = useHeader ? headerProblems(value.headers ?? []) : { blank: [], duplicates: [] };
  const sheetUrl = value.spreadsheet_id
    ? `https://docs.google.com/spreadsheets/d/${value.spreadsheet_id}/edit${value.sheet_id !== undefined && value.sheet_id >= 0 ? `#gid=${value.sheet_id}` : ""}`
    : null;
  const fileOptions: Option[] = (files ?? []).map((f) => ({
    value: f.id,
    label: f.name,
    hint: f.modifiedTime ? t("modified", { when: new Date(f.modifiedTime).toLocaleDateString() }) : undefined,
  }));
  const pickFile = (id: string) => {
    if (id === value.spreadsheet_id) return;
    setTabs([]);
    setTabsLoaded(false);
    void loadTabs(id, true);
  };
  const linkId = parseSpreadsheetId(link);

  return (
    <div className="flex flex-col gap-2">
      {/* 2. Connected Google account. */}
      <div className="flex items-center justify-between gap-2 text-[12px]">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`h-2 w-2 shrink-0 rounded-full ${account!.error ? "bg-amber-500" : "bg-emerald-500"}`} />
          <span className="font-medium">{account!.error ? t("needsReconnect") : t("connected")}</span>
          <span className="text-muted-foreground truncate">{account!.email}</span>
        </span>
        <button
          type="button"
          onClick={() => setChanging(true)}
          className="border-border hover:bg-muted shrink-0 rounded-md border px-2 py-0.5 text-[11.5px] font-medium"
        >
          {t("change")}
        </button>
      </div>
      {account!.error && signInBlock}

      {/* Spreadsheet. */}
      <div>
        <Label>{t("spreadsheet")}</Label>
        <div className="flex items-start gap-1">
          <Combobox
            value={value.spreadsheet_id ?? ""}
            selectedLabel={value.spreadsheet_id ? value.spreadsheet_title || value.spreadsheet_id : undefined}
            placeholder={t("selectSpreadsheet")}
            options={fileOptions}
            loading={busy === "files"}
            error={filesError}
            onOpen={() => files === null && void loadFiles()}
            onSearch={(q) => void loadFiles(q)}
            onSelect={pickFile}
            disabled={busy === "tabs" || busy === "headers"}
            ariaLabel={t("spreadsheet")}
          />
          <button
            type="button"
            title={t("refresh")}
            aria-label={t("refresh")}
            disabled={busy !== null}
            onClick={() => {
              void loadFiles();
              if (value.spreadsheet_id) void loadTabs(value.spreadsheet_id, false);
            }}
            className="border-border hover:bg-muted inline-flex h-[30px] shrink-0 items-center gap-1 rounded-md border px-2 text-[11.5px] disabled:opacity-50"
          >
            <RefreshCw className={busy !== null ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            {t("refreshShort")}
          </button>
        </div>
        {(filesError || account!.can_list === false) && (
          // No file list (old connection or Drive API off): a link still works.
          <div className="mt-1 flex gap-1">
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              aria-label={t("pasteLink")}
              className={FIELD}
            />
            <button
              type="button"
              onClick={() => linkId && pickFile(linkId)}
              disabled={!linkId || busy !== null}
              className="shrink-0 rounded-md border border-emerald-600 px-2 text-[12px] font-medium text-emerald-700 disabled:opacity-50 dark:text-emerald-400"
            >
              {t("load")}
            </button>
          </div>
        )}
        {sheetUrl && (
          <a href={sheetUrl} target="_blank" rel="noopener noreferrer" className={`${LINK} mt-1 text-[11.5px]`}>
            {t("viewSheet")} <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {/* 3. Tab. */}
      {value.spreadsheet_id && (
        <div>
          <Label>{t("tab")}</Label>
          <Combobox
            value={currentTab ? `${currentTab.id}|${currentTab.title}` : ""}
            selectedLabel={value.sheet_name || undefined}
            placeholder={t("selectSheet")}
            options={tabs.map((x) => ({ value: `${x.id}|${x.title}`, label: x.title }))}
            loading={busy === "tabs"}
            onOpen={() => !tabsLoaded && void loadTabs(value.spreadsheet_id!, false)}
            onSelect={(v) => {
              const tab = tabs.find((x) => `${x.id}|${x.title}` === v);
              if (tab) void loadHeaders(value.spreadsheet_id!, tab, { spreadsheet_title: value.spreadsheet_title });
            }}
            disabled={busy === "headers"}
            ariaLabel={t("tab")}
          />
        </div>
      )}

      {/* 4. Header row + example. */}
      {value.spreadsheet_id && value.sheet_name && (
        <div className="flex flex-col gap-1">
          {headerToggle && (
            <label className="flex items-center gap-2 text-[12.5px]">
              <input
                type="checkbox"
                className="accent-emerald-600"
                checked={useHeader}
                onChange={(e) => {
                  const tab = currentTab ?? { id: value.sheet_id ?? -1, title: value.sheet_name! };
                  // Changing what the columns are called invalidates mappings.
                  onChange({ first_row_header: e.target.checked, headers: [] });
                  void loadHeaders(
                    value.spreadsheet_id!,
                    tab,
                    { spreadsheet_title: value.spreadsheet_title, first_row_header: e.target.checked },
                    e.target.checked,
                  );
                }}
              />
              {t("firstRowHeader")}
            </label>
          )}
          <button type="button" onClick={() => void openPreview()} className={`${LINK} self-start text-[11.5px]`}>
            {t("viewExample")}
          </button>
          {busy === "headers" && (
            <p className="text-muted-foreground flex items-center gap-1 text-[11.5px]">
              <Loader2 className="h-3 w-3 animate-spin" /> {t("loadingColumns")}
            </p>
          )}
        </div>
      )}
      {(problems.duplicates.length > 0 || problems.blank.length > 0) && (
        <p className="text-[11px] leading-snug text-amber-600">
          {problems.duplicates.length > 0 && t("duplicateHeaders", { headers: problems.duplicates.join(", ") })}{" "}
          {problems.blank.length > 0 && t("blankHeaders", { columns: problems.blank.map((i) => columnLetter(i)).join(", ") })}
        </p>
      )}
      {error && <p className="text-[11.5px] leading-snug text-red-500">{error}</p>}
      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("exampleTitle", { tab: value.sheet_name ?? "" })}</DialogTitle>
            <DialogDescription>{t("exampleDesc")}</DialogDescription>
          </DialogHeader>
          {preview && preview.length === 0 ? (
            <p className="text-muted-foreground flex items-center gap-1 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> {t("checking")}
            </p>
          ) : (
            <div className="max-h-80 overflow-auto rounded-md border">
              <table className="w-full text-xs">
                <tbody>
                  {(preview ?? []).map((row, i) => (
                    <tr key={i} className={i === 0 && useHeader ? "bg-muted font-semibold" : "border-t"}>
                      <td className="text-muted-foreground px-2 py-1 tabular-nums">{i + 1}</td>
                      {row.map((cell, j) => (
                        <td key={j} className="max-w-[180px] truncate px-2 py-1" title={cell}>
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DialogContent>
      </Dialog>
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

interface RowLog {
  row_number: number;
  status: "started" | "skipped" | "failed";
  detail: string | null;
  created_at: string;
}

function useWatch(flowId: string) {
  const [watch, setWatch] = useState<WatchStatus | null>(null);
  const [rows, setRows] = useState<RowLog[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await getJson<{ watch: WatchStatus | null; rows?: RowLog[] }>(`/api/integrations/google/watch?flow_id=${flowId}`);
      if (!cancelled && r.ok) {
        setWatch(r.data.watch);
        setRows(r.data.rows ?? []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [flowId]);
  return { watch, rows };
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
  const sel = cfg as SheetSelection & {
    phone_column?: string;
    name_column?: string;
    wa_user_id_column?: string;
    customer_id_column?: string;
    default_country_code?: string;
  };
  const headers = (sel.headers ?? []).filter((h) => h.trim());
  const { watch, rows } = useWatch(flowId);
  const keys = headerKeys(sel.headers ?? []);
  const problems = rows.filter((r) => r.status !== "started").slice(0, 5);

  type Field = "phone_column" | "name_column" | "wa_user_id_column" | "customer_id_column";
  const pick = (field: Field, label: string, placeholder: string, help?: string) => (
    <div>
      <Label>{label}</Label>
      {help && <p className="text-muted-foreground -mt-0.5 mb-1 text-[10.5px] leading-snug">{help}</p>}
      <select value={sel[field] ?? ""} onChange={(e) => set({ [field]: e.target.value || undefined })} aria-label={label} className={FIELD}>
        <option value="">{placeholder}</option>
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
        headerToggle
        intro={t("triggerIntro")}
        onChange={(p) => {
          // A different file / tab / header mode invalidates the mappings.
          const changed =
            (p.spreadsheet_id !== undefined && p.spreadsheet_id !== sel.spreadsheet_id) ||
            (p.sheet_id !== undefined && p.sheet_id !== sel.sheet_id) ||
            (p.first_row_header !== undefined && p.first_row_header !== (sel.first_row_header !== false));
          const reset = changed
            ? { phone_column: undefined, name_column: undefined, wa_user_id_column: undefined, customer_id_column: undefined }
            : {};
          // Guess the phone column the first time headers arrive.
          const guess =
            (changed || !sel.phone_column) && p.headers ? p.headers.find((h) => /phone|mobile|whatsapp|number|contact/i.test(h)) : undefined;
          set({ ...p, ...reset, ...(guess ? { phone_column: guess } : {}) });
        }}
      />
      {headers.length > 0 && (
        <>
          {pick("phone_column", t("phoneField"), t("phonePlaceholder"), t("phoneFieldHelp"))}
          {pick("wa_user_id_column", t("usernameField"), t("usernamePlaceholder"), t("usernameFieldHelp"))}
          {pick("customer_id_column", t("customerIdField"), t("customerIdPlaceholder"), t("customerIdFieldHelp"))}
          {pick("name_column", t("nameColumn"), t("none"))}
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
      {sel.spreadsheet_id && <p className="text-muted-foreground text-[11px] leading-snug">{t("pollHint")}</p>}
      {watch && (
        <div className="border-border rounded-md border p-2 text-[11px] leading-snug">
          <div>
            {t("lastChecked")}: {watch.last_checked_at ? new Date(watch.last_checked_at).toLocaleString() : "—"}
          </div>
          <div>
            {t("rowsStarted")}: {watch.rows_fired}
          </div>
          {watch.last_error && <div className="text-red-500">{watch.last_error}</div>}
          {problems.length > 0 && (
            <div className="mt-1">
              <div className="font-medium">{t("skippedRows")}</div>
              <ul className="text-muted-foreground">
                {problems.map((r) => (
                  <li key={`${r.row_number}-${r.created_at}`} className="truncate" title={r.detail ?? ""}>
                    {t("rowProblem", { row: r.row_number, reason: r.detail ?? r.status })}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
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
    // Campaign / ad set / ad names: filled when a connected Facebook
    // account can read the ad (migration 054), else empty.
    return ["headline", "source_id", "source_url", "body", "campaign_name", "adset_name", "ad_name", "campaign_id", "adset_id"].map((k) => ({
      token: `trigger.${k}`,
    }));
  }
  return [];
}
