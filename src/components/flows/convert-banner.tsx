"use client";

/**
 * "Automations now live in Flows" — admins see how many automations are
 * not converted yet and convert them in one click. Each automation is
 * copied into an equivalent flow and switched off (kept, restorable).
 * Hidden for non-admins (the API answers 403) and before migration 048.
 */

import { useCallback, useEffect, useState } from "react";
import { ArrowRightLeft, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function ConvertAutomationsBanner({ onConverted }: { onConverted: () => void }) {
  const t = useTranslations("BotStudio.builder.convert");
  const [pending, setPending] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/flows/convert-automations", { cache: "no-store" });
      if (!res.ok) return setPending([]);
      const json = (await res.json()) as { available?: boolean; pending?: { id: string; name: string }[] };
      setPending(json.available ? (json.pending ?? []) : []);
    } catch {
      setPending([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (pending.length === 0) return null;

  const convert = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/flows/convert-automations", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        converted?: { name: string; notes: string[] }[];
        failed?: { name: string; error: string }[];
      };
      if (!res.ok) {
        toast.error(json.error ?? t("needsMigration"));
        return;
      }
      if (json.converted?.length) toast.success(t("done", { count: json.converted.length }));
      if (json.failed?.length) {
        toast.error(t("failed", { count: json.failed.length, names: json.failed.map((f) => f.name).join(", ") }));
      }
      await load();
      onConverted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-600/40 bg-emerald-600/5 p-4">
      <ArrowRightLeft className="h-5 w-5 shrink-0 text-emerald-600" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{t("title")}</p>
        <p className="text-muted-foreground text-[13px]">{t("body", { count: pending.length })}</p>
      </div>
      <Button onClick={() => void convert()} disabled={busy} className="bg-emerald-600 text-white hover:bg-emerald-700">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {busy ? t("working") : t("button")}
      </Button>
    </div>
  );
}
