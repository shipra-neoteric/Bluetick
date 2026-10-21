"use client";

/**
 * "How Bot Studio works" — short in-app guidance on the three building
 * blocks and the order they handle a message. Text only; no external
 * tutorials are invented.
 */

import { BookOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function BotStudioGuide() {
  const t = useTranslations("BotStudio.guide");
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" />}>
        <BookOpen className="h-4 w-4" />
        {t("open")}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("intro")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          {(["flows", "automations", "ai"] as const).map((k) => (
            <div key={k} className="space-y-1 rounded-lg border border-border p-3">
              <p className="text-sm font-semibold">{t(`${k}.title`)}</p>
              <p className="text-xs text-muted-foreground">{t(`${k}.what`)}</p>
              <p className="text-xs"><span className="font-medium">{t("useFor")}</span> {t(`${k}.use`)}</p>
            </div>
          ))}
        </div>
        <div className="space-y-1 rounded-lg bg-muted p-3 text-xs">
          <p className="font-medium">{t("orderTitle")}</p>
          <ol className="list-decimal space-y-0.5 pl-5 text-muted-foreground">
            <li>{t("order1")}</li>
            <li>{t("order2")}</li>
            <li>{t("order3")}</li>
          </ol>
        </div>
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>{t("tip1")}</li>
          <li>{t("tip2")}</li>
          <li>{t("tip3")}</li>
          <li>{t("tip4")}</li>
        </ul>
      </DialogContent>
    </Dialog>
  );
}
