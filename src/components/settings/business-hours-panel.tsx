"use client";

/**
 * Settings → Inbox → Business hours. Used by the Flow "Working hours"
 * step and the Automation "Working hours" condition. Admins edit (RLS);
 * everyone else sees the schedule read-only.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { isMissingSchemaError } from "@/lib/db/schema-compat";
import {
  DEFAULT_BUSINESS_HOURS,
  WEEKDAYS,
  validateBusinessHours,
  type BusinessHours,
  type Weekday,
} from "@/lib/bot/working-hours";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

const ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"];

export function BusinessHoursPanel() {
  const t = useTranslations("BotStudio.hours");
  const { accountId, user } = useAuth();
  const canEdit = useCan("edit-settings");
  const [hours, setHours] = useState<BusinessHours>(DEFAULT_BUSINESS_HOURS);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [saving, setSaving] = useState(false);
  const [newHoliday, setNewHoliday] = useState("");

  useEffect(() => {
    if (!accountId) return;
    void createClient()
      .from("business_hours")
      .select("timezone, schedule, holidays")
      .eq("account_id", accountId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          setState(isMissingSchemaError(error) ? "unavailable" : "ready");
          return;
        }
        if (data) setHours(data as BusinessHours);
        setState("ready");
      });
  }, [accountId]);

  const errors = validateBusinessHours(hours);

  function setDay(day: Weekday, windows: [string, string][]) {
    setHours((h) => ({ ...h, schedule: { ...h.schedule, [day]: windows } }));
  }

  async function save() {
    if (!accountId || errors.length) return;
    setSaving(true);
    const { error } = await createClient()
      .from("business_hours")
      .upsert({ account_id: accountId, ...hours, updated_by: user?.id ?? null, updated_at: new Date().toISOString() }, { onConflict: "account_id" });
    setSaving(false);
    if (error) toast.error(error.message);
    else toast.success(t("saved"));
  }

  if (state === "loading") return null;
  if (state === "unavailable") {
    return <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">{t("needsMigration")}</p>;
  }

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4" id="business-hours">
      <div>
        <h3 className="text-sm font-semibold">{t("title")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("subtitle")}</p>
      </div>
      <label className="block max-w-xs space-y-1 text-xs">
        <span className="text-muted-foreground">{t("timezone")}</span>
        <select disabled={!canEdit} value={hours.timezone} onChange={(e) => setHours((h) => ({ ...h, timezone: e.target.value }))} className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm">
          {[...new Set([hours.timezone, ...ZONES])].map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
      </label>
      <div className="space-y-2">
        {WEEKDAYS.map((day) => {
          const windows = hours.schedule?.[day] ?? [];
          const open = windows.length > 0;
          return (
            <div key={day} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-12 font-medium">{t(`days.${day}`)}</span>
              <Switch disabled={!canEdit} checked={open} onCheckedChange={(v) => setDay(day, v ? [["09:00", "18:00"]] : [])} aria-label={t("openOn", { day: t(`days.${day}`) })} />
              {open ? (
                windows.map((w, i) => (
                  <span key={i} className="flex items-center gap-1">
                    <Input disabled={!canEdit} type="time" value={w[0]} onChange={(e) => setDay(day, windows.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} className="h-8 w-28 bg-muted" />
                    –
                    <Input disabled={!canEdit} type="time" value={w[1]} onChange={(e) => setDay(day, windows.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} className="h-8 w-28 bg-muted" />
                    {canEdit && windows.length > 1 && (
                      <button type="button" aria-label={t("removeWindow")} onClick={() => setDay(day, windows.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-red-500">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </span>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">{t("closed")}</span>
              )}
              {open && canEdit && windows.length < 3 && (
                <button type="button" aria-label={t("addWindow")} title={t("addWindow")} onClick={() => setDay(day, [...windows, ["14:00", "18:00"]])} className="text-muted-foreground hover:text-primary">
                  <Plus className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium">{t("holidays")}</p>
        <div className="flex flex-wrap gap-1">
          {hours.holidays.map((d) => (
            <span key={d} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
              {d}
              {canEdit && (
                <button type="button" aria-label={t("removeHoliday", { date: d })} onClick={() => setHours((h) => ({ ...h, holidays: h.holidays.filter((x) => x !== d) }))}>
                  ×
                </button>
              )}
            </span>
          ))}
          {hours.holidays.length === 0 && <span className="text-xs text-muted-foreground">{t("noHolidays")}</span>}
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Input type="date" value={newHoliday} onChange={(e) => setNewHoliday(e.target.value)} className="h-8 w-44 bg-muted" />
            <Button size="sm" variant="outline" disabled={!newHoliday} onClick={() => { setHours((h) => ({ ...h, holidays: [...new Set([...h.holidays, newHoliday])].sort() })); setNewHoliday(""); }}>
              {t("addHoliday")}
            </Button>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">{t("holidayHint")}</p>
      </div>
      {errors.length > 0 && <p className="text-xs text-red-500">{errors.join(" · ")}</p>}
      {canEdit && (
        <Button size="sm" onClick={() => void save()} disabled={saving || errors.length > 0}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("save")}
        </Button>
      )}
    </section>
  );
}
