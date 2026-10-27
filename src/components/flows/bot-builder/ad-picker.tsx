"use client";

/**
 * Pick the Click-to-WhatsApp ads a trigger reacts to (stored as ad ids
 * in trigger_config.source_ids — the id WhatsApp sends in each ad
 * referral). Lists ads Bluetick has seen chats from, named from the
 * Meta Ads connection when it is set up. An id can also be typed, for
 * an ad that has not brought a chat yet. Empty = any ad.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";

const AD_ID = /^[0-9]{5,30}$/;

interface AdOption {
  id: string;
  name: string | null;
  campaign: string | null;
  chats: number;
  lastAt: string | null;
}

export function AdPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const t = useTranslations("BotStudio.builder.ads");
  const [ads, setAds] = useState<AdOption[] | null>(null);
  const [meta, setMeta] = useState<"connected" | "not_connected" | "error">("not_connected");
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/ads/options", { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as { ads?: AdOption[]; meta?: typeof meta };
        if (cancelled) return;
        if (!res.ok) {
          setFailed(true);
          setAds([]);
          return;
        }
        setAds(json.ads ?? []);
        setMeta(json.meta ?? "not_connected");
      } catch {
        if (!cancelled) {
          setFailed(true);
          setAds([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const label = (id: string) => {
    const a = ads?.find((x) => x.id === id);
    return a?.name ? `${a.name} · ${id}` : id;
  };
  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (ads ?? []).filter(
        (a) =>
          !value.includes(a.id) &&
          (!needle || a.id.includes(needle) || (a.name ?? "").toLowerCase().includes(needle) || (a.campaign ?? "").toLowerCase().includes(needle)),
      ),
    [ads, value, needle],
  );
  const typedId = AD_ID.test(q.trim()) && !value.includes(q.trim()) && !shown.some((a) => a.id === q.trim()) ? q.trim() : null;
  const add = (id: string) => {
    onChange([...value, id].slice(0, 50));
    setQ("");
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1">
        {value.length === 0 && <span className="text-muted-foreground text-[11.5px]">{t("anyAd")}</span>}
        {value.map((id) => (
          <span key={id} className="inline-flex max-w-full items-center gap-1 rounded-full border border-emerald-600/40 bg-emerald-600/10 px-2 py-0.5 text-[11px]">
            <span className="truncate">{label(id)}</span>
            <button type="button" aria-label={t("remove")} onClick={() => onChange(value.filter((x) => x !== id))}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="border-border rounded-md border">
        <label className="flex items-center gap-1 px-2 py-1">
          <Search className="text-muted-foreground h-3.5 w-3.5" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setOpen(true)}
            placeholder={t("search")}
            aria-label={t("search")}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none"
          />
        </label>
        {open && (
          <div className="border-border max-h-40 overflow-y-auto border-t py-1">
            {ads === null && (
              <p className="text-muted-foreground flex items-center gap-1 px-2 py-1 text-[11.5px]">
                <Loader2 className="h-3 w-3 animate-spin" /> {t("loading")}
              </p>
            )}
            {typedId && (
              <button type="button" onClick={() => add(typedId)} className="hover:bg-muted block w-full px-2 py-1 text-left text-[12px]">
                {t("addId", { id: typedId })}
              </button>
            )}
            {shown.map((a) => (
              <button key={a.id} type="button" onClick={() => add(a.id)} className="hover:bg-muted block w-full px-2 py-1 text-left">
                <div className="truncate text-[12.5px] font-medium">{a.name || a.id}</div>
                <div className="text-muted-foreground truncate text-[10.5px]">
                  {[a.campaign, a.name ? a.id : null, a.chats ? t("chats", { count: a.chats }) : null].filter(Boolean).join(" · ")}
                </div>
              </button>
            ))}
            {ads !== null && shown.length === 0 && !typedId && (
              <p className="text-muted-foreground px-2 py-1 text-[11.5px]">{failed ? t("loadFailed") : t("none")}</p>
            )}
          </div>
        )}
      </div>
      {meta !== "connected" && (
        <p className="text-muted-foreground text-[10.5px] leading-snug">
          {meta === "error" ? t("metaError") : t("metaHint")}{" "}
          <Link href="/ads" className="text-emerald-700 underline dark:text-emerald-400">
            {t("openAds")}
          </Link>
        </p>
      )}
    </div>
  );
}
