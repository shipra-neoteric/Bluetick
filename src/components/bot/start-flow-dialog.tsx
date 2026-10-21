"use client";

/** Inbox → ⋮ → Start a flow: run an active flow for this conversation. */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function StartFlowDialog({
  open,
  onOpenChange,
  conversationId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  conversationId: string;
}) {
  const t = useTranslations("BotStudio.start");
  const [flows, setFlows] = useState<{ id: string; name: string; trigger_type: string }[]>([]);
  const [flowId, setFlowId] = useState("");
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void createClient()
      .from("flows")
      .select("id, name, trigger_type")
      .eq("status", "active")
      .order("name")
      .then(({ data }) => setFlows((data ?? []) as typeof flows));
  }, [open]);

  async function start() {
    setBusy(true);
    const res = await fetch(`/api/flows/${flowId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: conversationId, replace_active: replace }),
    });
    const body = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      toast.error(body?.error ?? t("failed"));
      return;
    }
    toast.success(t("started"));
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("desc")}</DialogDescription>
        </DialogHeader>
        {flows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("none")}</p>
        ) : (
          <select value={flowId} onChange={(e) => setFlowId(e.target.value)} className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm">
            <option value="">{t("pick")}</option>
            {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        )}
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={replace} onCheckedChange={(v) => setReplace(!!v)} />
          {t("replace")}
        </label>
        <p className="text-[11px] text-muted-foreground">{t("windowNote")}</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={() => void start()} disabled={!flowId || busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
