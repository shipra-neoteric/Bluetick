"use client";

/**
 * Call Api (A20). The card selects a saved API definition (shared by all
 * flows); "Create New API" / "Edit" open the editor:
 *   name, method, endpoint, headers, JSON body, response → variables,
 *   Import from cURL (parsed in the browser, never executed),
 *   Test API (one real request from the server, on click only),
 *   Save API.
 * Outputs: Success (2xx) and Failure, rendered by the canvas.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { parseCurl } from "@/lib/bot/curl";
import type { BuilderNode } from "../shared";
import { Label } from "./message-bodies";

const FIELD = "border-border w-full rounded-md border bg-transparent px-2 py-1.5 text-[13px] outline-none focus:border-emerald-600";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export interface SavedApi {
  id: string;
  name: string;
  method: (typeof METHODS)[number];
  url: string;
  headers: { key: string; value: string }[];
  body: string | null;
  response_map: { path: string; var: string }[];
}

function useSavedApis() {
  const [apis, setApis] = useState<SavedApi[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/bot/apis", { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as { available?: boolean; apis?: SavedApi[] };
        if (cancelled) return;
        if (!res.ok) setState("error");
        else if (json.available === false) setState("missing");
        else {
          setApis(json.apis ?? []);
          setState("ready");
        }
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);
  return { apis: apis ?? [], state, reload };
}

export function CallApiBody({ node, onUpdate }: { node: BuilderNode; onUpdate: (p: Record<string, unknown>) => void }) {
  const t = useTranslations("BotStudio.builder.api");
  const c = node.config as { api_id?: string; response_var?: string };
  const { apis, state, reload } = useSavedApis();
  const [editing, setEditing] = useState<SavedApi | "new" | null>(null);
  const current = apis.find((a) => a.id === c.api_id);

  return (
    <div className="flex flex-col gap-2">
      {state === "missing" && <p className="text-[11.5px] text-amber-600">{t("needsMigration")}</p>}
      {state === "error" && <p className="text-[11.5px] text-red-500">{t("loadFailed")}</p>}
      <div className="flex items-center gap-1">
        <select
          value={c.api_id ?? ""}
          onChange={(e) => onUpdate({ api_id: e.target.value })}
          disabled={state !== "ready"}
          className={FIELD}
          aria-label={t("select")}
        >
          <option value="">{state === "loading" ? t("loading") : t("select")}</option>
          {apis.map((a) => (
            <option key={a.id} value={a.id}>{`${a.method} · ${a.name}`}</option>
          ))}
          {c.api_id && !current && state === "ready" && <option value={c.api_id}>{t("deleted")}</option>}
        </select>
        {current && (
          <button type="button" onClick={() => setEditing(current)} aria-label={t("edit")} className="border-border hover:bg-muted rounded-md border p-1.5">
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <button
        type="button"
        disabled={state !== "ready"}
        onClick={() => setEditing("new")}
        className="inline-flex items-center gap-1 self-start text-[12px] font-medium text-emerald-700 disabled:opacity-50 dark:text-emerald-400"
      >
        <Plus className="h-3.5 w-3.5" /> {t("createNew")}
      </button>
      {current && <p className="text-muted-foreground truncate text-[11px]" title={current.url}>{current.url}</p>}
      <div>
        <Label>{t("responseVar")}</Label>
        <input value={c.response_var ?? ""} onChange={(e) => onUpdate({ response_var: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })} placeholder="api_response" className={FIELD} />
        <p className="text-muted-foreground mt-0.5 text-[10.5px]">{t("responseVarHint")}</p>
      </div>
      {editing && (
        <ApiEditorDialog
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(api) => {
            void reload();
            onUpdate({ api_id: api.id });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ApiEditorDialog({ initial, onClose, onSaved }: { initial: SavedApi | null; onClose: () => void; onSaved: (api: SavedApi) => void }) {
  const t = useTranslations("BotStudio.builder.api");
  const [name, setName] = useState(initial?.name ?? "");
  const [method, setMethod] = useState<SavedApi["method"]>(initial?.method ?? "POST");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [headers, setHeaders] = useState(initial?.headers?.length ? initial.headers : [{ key: "", value: "" }]);
  const [body, setBody] = useState(initial?.body ?? "");
  const [map, setMap] = useState(initial?.response_map ?? []);
  const [curl, setCurl] = useState("");
  const [showCurl, setShowCurl] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; status: number; error: string | null; body: string; mapped: Record<string, unknown> } | null>(null);

  const payload = () => ({ name, method, url, headers: headers.filter((h) => h.key.trim()), body, response_map: map.filter((m) => m.path || m.var) });

  const importCurl = () => {
    try {
      const p = parseCurl(curl);
      setMethod(p.method);
      setUrl(p.url);
      setHeaders(p.headers.length ? p.headers : [{ key: "", value: "" }]);
      setBody(p.body);
      setShowCurl(false);
      toast.success(t("imported"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("importFailed"));
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch("/api/bot/apis/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload()) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(json.error ?? t("testFailed"));
      else setResult(json);
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(initial ? `/api/bot/apis/${initial.id}` : "/api/bot/apis", {
        method: initial ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? t("saveFailed"));
        return;
      }
      toast.success(t("saved"));
      onSaved(json.api as SavedApi);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial ? t("editTitle") : t("createTitle")}</DialogTitle>
          <DialogDescription>{t("dialogHint")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <Label>{t("name")}</Label>
            <input value={name} onChange={(e) => setName(e.target.value)} className={FIELD} placeholder={t("namePlaceholder")} />
          </div>
          <div className="flex gap-2">
            <select value={method} onChange={(e) => setMethod(e.target.value as SavedApi["method"])} className={cn(FIELD, "w-28")} aria-label={t("method")}>
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <input value={url} onChange={(e) => setUrl(e.target.value)} className={FIELD} placeholder="https://api.example.com/leads/{{vars.id}}" aria-label={t("endpoint")} />
          </div>
          <div>
            <button type="button" onClick={() => setShowCurl((v) => !v)} className="text-[12px] font-medium text-emerald-700 dark:text-emerald-400">
              {t("importCurl")}
            </button>
            {showCurl && (
              <div className="mt-1 flex flex-col gap-1">
                <textarea value={curl} onChange={(e) => setCurl(e.target.value)} rows={4} className={cn(FIELD, "font-mono text-[12px]")} placeholder="curl -X POST https://… -H 'Authorization: Bearer …' -d '{…}'" />
                <p className="text-muted-foreground text-[11px]">{t("curlHint")}</p>
                <Button size="sm" variant="outline" className="self-start" onClick={importCurl}>{t("importButton")}</Button>
              </div>
            )}
          </div>
          <div>
            <Label>{t("headers")}</Label>
            {headers.map((h, i) => (
              <div key={i} className="mb-1 flex gap-1">
                <input value={h.key} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} placeholder={t("headerKey")} className={FIELD} />
                <input value={h.value} onChange={(e) => setHeaders(headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder={t("headerValue")} className={FIELD} />
                <button type="button" aria-label={t("remove")} onClick={() => setHeaders(headers.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-red-500">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setHeaders([...headers, { key: "", value: "" }])} className="text-[12px] text-emerald-700 dark:text-emerald-400">
              + {t("addHeader")}
            </button>
          </div>
          {method !== "GET" && (
            <div>
              <Label>{t("body")}</Label>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} className={cn(FIELD, "font-mono text-[12px]")} placeholder='{"phone": "{{contact.phone}}", "name": "{{contact.name}}"}' />
            </div>
          )}
          <div>
            <Label>{t("responseMap")}</Label>
            <p className="text-muted-foreground mb-1 text-[11px]">{t("responseMapHint")}</p>
            {map.map((m, i) => (
              <div key={i} className="mb-1 flex gap-1">
                <input value={m.path} onChange={(e) => setMap(map.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} placeholder="data.id" className={FIELD} />
                <input value={m.var} onChange={(e) => setMap(map.map((x, j) => (j === i ? { ...x, var: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") } : x)))} placeholder="lead_id" className={FIELD} />
                <button type="button" aria-label={t("remove")} onClick={() => setMap(map.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-red-500">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <button type="button" onClick={() => setMap([...map, { path: "", var: "" }])} className="text-[12px] text-emerald-700 dark:text-emerald-400">
              + {t("addMapping")}
            </button>
          </div>
          <div className="border-border rounded-md border p-2">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium">{t("response")}</span>
              <Button size="sm" variant="outline" onClick={() => void test()} disabled={testing || !url}>
                {testing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {t("test")}
              </Button>
            </div>
            <p className="text-muted-foreground mt-1 text-[11px]">{t("testHint")}</p>
            {result && (
              <div className="mt-2 text-[12px]">
                <div className={result.ok ? "text-emerald-600" : "text-red-500"}>
                  {result.status ? `HTTP ${result.status}` : ""} {result.error ?? ""}
                </div>
                {Object.keys(result.mapped).length > 0 && (
                  <div className="text-muted-foreground mt-1">{Object.entries(result.mapped).map(([k, v]) => `vars.${k} = ${String(v).slice(0, 60)}`).join(" · ")}</div>
                )}
                <pre className="bg-muted mt-1 max-h-48 overflow-auto rounded p-2 text-[11px] whitespace-pre-wrap">{result.body}</pre>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("cancel")}</Button>
          <Button onClick={() => void save()} disabled={saving || !name.trim() || !url.trim()} className="bg-emerald-600 text-white hover:bg-emerald-700">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
