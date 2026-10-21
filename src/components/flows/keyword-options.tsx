"use client";

import { useTranslations } from "next-intl";
import { Switch } from "@/components/ui/switch";

const SELECT =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none";

/** Match type, case sensitivity and restart policy for keyword triggers. */
export function KeywordOptions({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const t = useTranslations("BotStudio.flows.settings");
  return (
    <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">{t("matchType")}</label>
        <select value={(config.match_type as string) ?? "contains"} onChange={(e) => onChange({ match_type: e.target.value })} className={SELECT}>
          <option value="contains">{t("matchContains")}</option>
          <option value="word">{t("matchWord")}</option>
          <option value="exact">{t("matchExact")}</option>
        </select>
      </div>
      <label className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
        <Switch checked={config.case_sensitive === true} onCheckedChange={(v) => onChange({ case_sensitive: !!v })} />
        {t("caseSensitive")}
      </label>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">{t("whenInFlow")}</label>
        <select value={(config.restart_policy as string) ?? "continue"} onChange={(e) => onChange({ restart_policy: e.target.value })} className={SELECT}>
          <option value="continue">{t("restartContinue")}</option>
          <option value="restart">{t("restartRestart")}</option>
        </select>
      </div>
      <p className="text-[11px] text-muted-foreground md:col-span-3">
        {(config.restart_policy as string) === "restart" ? t("restartHint") : t("continueHint")}
      </p>
    </div>
  );
}
