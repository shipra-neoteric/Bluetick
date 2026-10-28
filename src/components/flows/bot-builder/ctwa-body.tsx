"use client";

/**
 * Click-to-WhatsApp triggers in the Bot Builder:
 *   - CtwaMessageTriggerBody: "Message from CTWA" — same settings as below;
 *   - CtwaLeadTriggerBody: "Lead From CTWA" — a connected Facebook
 *     account, then all ads / one campaign / one ad set (migration 054).
 *
 * The webhook resolves each chat's ad to its campaign and ad set with
 * the account's connected Facebook users, so the trigger stores only the
 * picked id (+ name, for display). Older configs with ad ids
 * (source_ids) or lead_mode keep working; the ad-id list is shown so it
 * can be cleared.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, Loader2, Plus, Search, TriangleAlert } from "lucide-react";
import { Label } from "./message-bodies";
import { connectFacebookPopup, useMetaConnections } from "@/components/meta/use-meta-connections";

const FIELD = "border-border w-full rounded-md border bg-transparent px-2 py-1.5 text-[13px] outline-none focus:border-emerald-600";
const CONNECT = "__connect__";
const VARIABLES = ["campaign_name", "adset_name", "ad_name", "headline", "source_id", "source_url", "body", "source_type"];

type Cfg = Record<string, unknown>;
type SetCfg = (patch: Cfg) => void;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * "Message from CTWA": the same account → all / campaign / ad set picker
 * as "Lead From CTWA" (the engine matches both with ctwaAdMatches).
 */
export function CtwaMessageTriggerBody({ cfg, set }: { cfg: Cfg; set: SetCfg }) {
  return <CtwaLeadTriggerBody cfg={cfg} set={set} />;
}

/** "Lead From CTWA" trigger settings. */
export function CtwaLeadTriggerBody({ cfg, set }: { cfg: Cfg; set: SetCfg }) {
  const t = useTranslations("BotStudio.builder.ctwaLead");
  const connectionId = str(cfg.meta_connection_id);
  const track = cfg.track === "campaign" || cfg.track === "adset" ? cfg.track : "all";
  const legacyIds = Array.isArray(cfg.source_ids) ? (cfg.source_ids as string[]).filter(Boolean) : [];

  return (
    <div className="flex flex-col gap-2.5">
      <MetaAccountField
        value={connectionId}
        onChange={(id) =>
          // Another Facebook user sees other campaigns: re-pick.
          set(id === connectionId ? {} : { meta_connection_id: id || undefined, campaign_id: undefined, campaign_name: undefined, adset_id: undefined, adset_name: undefined })
        }
      />

      {connectionId && (
        <>
          <div>
            <Label>{t("trackFrom")}</Label>
            <select
              value={track}
              onChange={(e) =>
                set({ track: e.target.value, campaign_id: undefined, campaign_name: undefined, adset_id: undefined, adset_name: undefined })
              }
              aria-label={t("trackFrom")}
              className={FIELD}
            >
              <option value="all">{t("track.all")}</option>
              <option value="campaign">{t("track.campaign")}</option>
              <option value="adset">{t("track.adset")}</option>
            </select>
          </div>
          {track !== "all" && (
            <div>
              <Label>{track === "campaign" ? t("selectCampaign") : t("selectAdSet")}</Label>
              <CampaignSelect
                connectionId={connectionId}
                level={track}
                value={track === "campaign" ? { id: str(cfg.campaign_id), name: str(cfg.campaign_name) } : { id: str(cfg.adset_id), name: str(cfg.adset_name) }}
                onChange={(o) =>
                  set(track === "campaign" ? { campaign_id: o.id, campaign_name: o.name } : { adset_id: o.id, adset_name: o.name })
                }
              />
            </div>
          )}
        </>
      )}

      {legacyIds.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-[11.5px] leading-snug">
          {t("legacyAds", { count: legacyIds.length })}{" "}
          <button type="button" onClick={() => set({ source_ids: [] })} className="font-medium text-emerald-700 underline dark:text-emerald-400">
            {t("legacyClear")}
          </button>
        </div>
      )}

      <div className="text-muted-foreground text-[11px] leading-snug">
        <div className="mb-0.5 font-medium">{t("variables")}</div>
        <div className="flex flex-wrap gap-1">
          {VARIABLES.map((k) => (
            <code key={k} className="bg-muted rounded px-1 text-[10.5px]">{`{{trigger.${k}}}`}</code>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * "Select Account": connected Facebook users by name, plus "Connect new
 * Facebook account" (Facebook Login popup; the new account is selected).
 * Once chosen: "● Connected to <name>" with Change.
 */
function MetaAccountField({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const t = useTranslations("BotStudio.builder.ctwaLead");
  const { state, failed, reload } = useMetaConnections();
  const [changing, setChanging] = useState(false);
  const [waiting, setWaiting] = useState<null | (() => void)>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const current = state?.connections.find((c) => c.id === value);

  const connect = () => {
    setProblem(null);
    const { done, cancel } = connectFacebookPopup();
    setWaiting(() => cancel);
    void done.then((r) => {
      setWaiting(null);
      reload();
      if (r.ok) {
        onChange(r.id);
        setChanging(false);
      } else if (r.reason !== "cancelled") {
        setProblem(r.reason);
      }
    });
  };

  if (state === null) {
    return (
      <p className="text-muted-foreground flex items-center gap-1 text-[11.5px]">
        <Loader2 className="h-3 w-3 animate-spin" /> {t("loadingAccounts")}
      </p>
    );
  }
  if (!state.available) return <p className="text-[11.5px] text-amber-600">{t("needsMigration")}</p>;

  const problemText = problem ? (["blocked", "not_configured", "missing_scope", "denied", "forbidden"].includes(problem) ? t(`connectResult.${problem}`) : t("connectResult.error")) : null;

  if (value && current && !changing) {
    return (
      <div>
        <Label>{t("account")}</Label>
        <div className="border-border flex items-center gap-2 rounded-md border px-2 py-1.5">
          <span className={`h-2 w-2 shrink-0 rounded-full ${current.error ? "bg-amber-500" : "bg-emerald-500"}`} />
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{t("connectedTo", { name: current.name ?? current.fb_user_id })}</span>
          <button type="button" onClick={() => setChanging(true)} className="text-[12px] font-medium text-emerald-700 hover:underline dark:text-emerald-400">
            {t("change")}
          </button>
        </div>
        {current.error && (
          <p className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-amber-600">
            <TriangleAlert className="mt-px h-3 w-3 shrink-0" /> {t("reconnectHint")}
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      <Label>{t("account")}</Label>
      <select
        value={current ? value : ""}
        onChange={(e) => {
          if (e.target.value === CONNECT) connect();
          else if (e.target.value) {
            onChange(e.target.value);
            setChanging(false);
          }
        }}
        aria-label={t("account")}
        className={FIELD}
        disabled={Boolean(waiting)}
      >
        <option value="">{t("selectAccount")}</option>
        {state.connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name ?? c.fb_user_id}
            {c.error ? ` (${t("needsReconnect")})` : ""}
          </option>
        ))}
        {state.configured && <option value={CONNECT}>{t("connectNew")}</option>}
      </select>
      {waiting && (
        <p className="text-muted-foreground mt-1 flex items-center gap-1 text-[11.5px]">
          <Loader2 className="h-3 w-3 animate-spin" /> {t("waitingForFacebook")}
          <button type="button" onClick={() => waiting()} className="ml-1 font-medium text-emerald-700 hover:underline dark:text-emerald-400">
            {t("cancel")}
          </button>
        </p>
      )}
      {value && !current && <p className="mt-1 text-[11px] leading-snug text-amber-600">{t("accountMissing")}</p>}
      {!state.configured && <p className="mt-1 text-[11px] leading-snug text-amber-600">{t("notConfigured")}</p>}
      {failed && <p className="mt-1 text-[11px] text-amber-600">{t("accountsFailed")}</p>}
      {problemText && <p className="mt-1 text-[11px] leading-snug text-amber-600">{problemText}</p>}
      {state.configured && state.connections.length === 0 && !waiting && (
        <button
          type="button"
          onClick={connect}
          className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md border border-emerald-600 py-1.5 text-[12.5px] font-medium text-emerald-700 hover:bg-emerald-600/5 dark:text-emerald-400"
        >
          <Plus className="h-3.5 w-3.5" /> {t("connectNew")}
        </button>
      )}
      {changing && current && (
        <button type="button" onClick={() => setChanging(false)} className="text-muted-foreground mt-1 text-[11px] hover:underline">
          {t("keep", { name: current.name ?? current.fb_user_id })}
        </button>
      )}
    </div>
  );
}

interface CampaignOption {
  id: string;
  name: string;
  status: string | null;
  ad_account_name: string | null;
  campaign_name?: string | null;
}

/** Searchable "Select Value" for one campaign / ad set of the Facebook user. */
function CampaignSelect({
  connectionId,
  level,
  value,
  onChange,
}: {
  connectionId: string;
  level: "campaign" | "adset";
  value: { id: string; name: string };
  onChange: (o: { id: string; name: string }) => void;
}) {
  const t = useTranslations("BotStudio.builder.ctwaLead");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<CampaignOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // Load when opened; search on Meta's side (debounced).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = window.setTimeout(
      () => {
        setOptions(null);
        setError(null);
        const qs = new URLSearchParams({ connection: connectionId, level, q: q.trim() });
        void fetch(`/api/meta/campaigns?${qs}`, { cache: "no-store" })
          .then(async (res) => {
            const json = (await res.json().catch(() => ({}))) as { options?: CampaignOption[]; error?: string };
            if (cancelled) return;
            if (!res.ok) {
              setError(json.error || t("campaignsFailed"));
              setOptions([]);
            } else setOptions(json.options ?? []);
          })
          .catch(() => {
            if (!cancelled) {
              setError(t("campaignsFailed"));
              setOptions([]);
            }
          });
      },
      q ? 400 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, q, connectionId, level, t]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`${FIELD} flex items-center gap-1 text-left`}
      >
        <span className={`min-w-0 flex-1 truncate ${value.id ? "" : "text-muted-foreground"}`}>{value.id ? value.name || value.id : t("selectValue")}</span>
        <ChevronDown className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
      </button>
      {open && (
        <div className="border-border bg-popover absolute z-20 mt-1 w-full rounded-md border shadow-md">
          <label className="border-border flex items-center gap-1 border-b px-2 py-1">
            <Search className="text-muted-foreground h-3.5 w-3.5" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={level === "campaign" ? t("searchCampaigns") : t("searchAdSets")}
              aria-label={level === "campaign" ? t("searchCampaigns") : t("searchAdSets")}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none"
            />
          </label>
          <div className="max-h-52 overflow-y-auto py-1">
            {options === null && (
              <p className="text-muted-foreground flex items-center gap-1 px-2 py-1 text-[11.5px]">
                <Loader2 className="h-3 w-3 animate-spin" /> {t("loadingCampaigns")}
              </p>
            )}
            {options?.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => {
                  onChange({ id: o.id, name: o.name });
                  setOpen(false);
                  setQ("");
                }}
                className={`hover:bg-muted block w-full px-2 py-1 text-left ${o.id === value.id ? "bg-emerald-600/10" : ""}`}
              >
                <div className="truncate text-[12.5px] font-medium">{o.name}</div>
                <div className="text-muted-foreground truncate text-[10.5px]">
                  {[o.campaign_name, o.ad_account_name, o.status && o.status !== "ACTIVE" ? o.status.toLowerCase().replace(/_/g, " ") : null]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </button>
            ))}
            {options !== null && options.length === 0 && (
              <p className="text-muted-foreground px-2 py-1 text-[11.5px]">{error ?? (level === "campaign" ? t("noCampaigns") : t("noAdSets"))}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
