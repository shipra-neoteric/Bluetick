"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Workflow,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  MessageSquare,
  PlayCircle,
  PauseCircle,
  Archive,
  HelpCircle,
  UserPlus,
  FileText,
  Search,
  ScrollText,
  LayoutGrid,
  List as ListIcon,
  Zap,
} from "lucide-react";
import { BotStudioGuide } from "@/components/bot/bot-studio-guide";
import { ConvertAutomationsBanner } from "@/components/flows/convert-banner";
import { TRIGGER_SECTIONS } from "@/components/flows/bot-builder/catalog";

import { useTranslations } from "next-intl";
import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Flows list page.
 *
 * Open to every authenticated user. Flows is in soft-GA — the "Beta"
 * chip in the header is the only remaining signal that the surface
 * is new. The previous per-account beta gate was removed in PR #134.
 */

interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  trigger_type: import("@/lib/flows/types").FlowTriggerKind;
  trigger_config: { keywords?: string[] } | Record<string, unknown>;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
  has_unpublished_changes?: boolean;
  /** Creator (the API returns the whole row). */
  user_id: string;
}

type SortKey = "updated" | "newest" | "oldest" | "name" | "runs";
const VIEW_KEY = "bluetick.flows.view";

const STATUS_LABELS = (t: ReturnType<typeof useTranslations>): Record<FlowRow["status"], string> => ({
  draft: t("statusDraft"),
  active: t("statusActive"),
  archived: t("statusArchived"),
});

const STATUS_COLORS: Record<FlowRow["status"], string> = {
  draft: "border-border bg-muted text-muted-foreground",
  active: "border-emerald-600/40 bg-emerald-500/10 text-emerald-300",
  archived: "border-border bg-muted/50 text-muted-foreground",
};

interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  icon: "MessageSquare" | "HelpCircle" | "UserPlus";
  trigger_type: string;
  node_count: number;
}

const TEMPLATE_ICONS = {
  MessageSquare,
  HelpCircle,
  UserPlus,
} as const;

export default function FlowsPage() {
  const router = useRouter();
  const canCreate = useCan("send-messages");
  const t = useTranslations("Flows.list");
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const tb = useTranslations("BotStudio.lists");
  const tc = useTranslations("BotStudio.builder.convert");
  const ti = useTranslations("BotStudio.builder.items");
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | FlowRow["status"]>("all");
  const [triggerFilter, setTriggerFilter] = useState<"all" | FlowRow["trigger_type"]>("all");
  const [sort, setSort] = useState<SortKey>("updated");
  const [view, setView] = useState<"cards" | "table">("cards");
  useEffect(() => {
    try {
      if (localStorage.getItem(VIEW_KEY) === "table") setView("table");
    } catch {
      // storage blocked
    }
  }, []);
  const chooseView = (v: "cards" | "table") => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // ignore
    }
  };
  // "All Agents" (B01.04): filter by who created the flow.
  const [creatorFilter, setCreatorFilter] = useState<string>("all");
  const [members, setMembers] = useState<{ user_id: string; full_name?: string | null; email?: string | null }[]>([]);
  useEffect(() => {
    void fetch("/api/account/members", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((j: { members?: typeof members }) => setMembers(j.members ?? []))
      .catch(() => setMembers([]));
  }, []);
  const memberName = (id: string) => {
    const m = members.find((x) => x.user_id === id);
    return m ? m.full_name || m.email || "—" : "—";
  };
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = flows.filter(
      (f) =>
        (statusFilter === "all" || f.status === statusFilter) &&
        (creatorFilter === "all" || f.user_id === creatorFilter) &&
        (triggerFilter === "all" || f.trigger_type === triggerFilter) &&
        (!needle ||
          f.name.toLowerCase().includes(needle) ||
          (f.description ?? "").toLowerCase().includes(needle) ||
          JSON.stringify(f.trigger_config).toLowerCase().includes(needle)),
    );
    const by: Record<SortKey, (a: FlowRow, b: FlowRow) => number> = {
      updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
      newest: (a, b) => b.created_at.localeCompare(a.created_at),
      oldest: (a, b) => a.created_at.localeCompare(b.created_at),
      name: (a, b) => a.name.localeCompare(b.name),
      runs: (a, b) => b.execution_count - a.execution_count,
    };
    return [...list].sort(by[sort]);
  }, [flows, q, statusFilter, triggerFilter, creatorFilter, sort]);

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [flowsRes, tmplRes] = await Promise.all([
          fetch("/api/flows"),
          fetch("/api/flows/templates"),
        ]);
        if (!flowsRes.ok) {
          throw new Error(`Failed to load flows: ${flowsRes.status}`);
        }
        const flowsJson = (await flowsRes.json()) as { flows: FlowRow[] };
        if (!cancelled) setFlows(flowsJson.flows ?? []);
        // Templates endpoint is forward-looking — if it 404s on an
        // older deployment, gracefully fall through.
        if (tmplRes.ok) {
          const tmplJson = (await tmplRes.json()) as {
            templates: TemplateSummary[];
          };
          if (!cancelled) setTemplates(tmplJson.templates ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          toast.error(t("loadError"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable
  }, [reloadKey]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          trigger_type: "keyword",
          trigger_config: { keywords: [] },
        }),
      });
      if (!res.ok) throw new Error(`Create failed: ${res.status}`);
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      setNewName("");
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      console.error(err);
      toast.error(t("createError"));
    } finally {
      setCreating(false);
    }
  }

  async function handleUseTemplate(slug: string) {
    setCreating(true);
    try {
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_slug: slug }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `Clone failed: ${res.status}`);
      }
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("cloneError");
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(flow: FlowRow) {
    const yes = window.confirm(t("deleteConfirm", { name: flow.name }));
    if (!yes) return;
    try {
      const res = await fetch(`/api/flows/${flow.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
      toast.success(t("deleteSuccess"));
    } catch (err) {
      console.error(err);
      toast.error(t("deleteError"));
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-foreground">{t("title")}</h1>
            <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
              {t("beta")}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BotStudioGuide />
          <Button variant="outline" onClick={() => router.push("/automations")}>
            <Zap className="h-4 w-4" />
            {tc("archive")}
          </Button>
          <Button variant="outline" onClick={() => router.push("/bot-logs")}>
            <ScrollText className="h-4 w-4" />
            {tb("botLogs")}
          </Button>
          <GatedButton
            canAct={canCreate}
            gateReason="create flows"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="h-4 w-4" />
            {t("newFlow")}
          </GatedButton>
        </div>
      </header>

      <ConvertAutomationsBanner onConverted={() => setReloadKey((k) => k + 1)} />

      {flows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tb("searchFlows")} className="pl-8" />
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className="h-9 rounded-md border border-border bg-muted px-2 text-sm" aria-label={tb("status")}>
            <option value="all">{tb("allStatuses")}</option>
            <option value="active">{t("statusActive")}</option>
            <option value="draft">{t("statusDraft")}</option>
            <option value="archived">{t("statusArchived")}</option>
          </select>
          <select value={triggerFilter} onChange={(e) => setTriggerFilter(e.target.value as typeof triggerFilter)} className="h-9 rounded-md border border-border bg-muted px-2 text-sm" aria-label={tb("trigger")}>
            <option value="all">{tb("allTriggers")}</option>
            <option value="keyword">{tb("triggerKeyword")}</option>
            <option value="first_inbound_message">{tb("triggerFirst")}</option>
            <option value="manual">{tb("triggerManual")}</option>
            <optgroup label={tc("events")}>
              {EVENT_TRIGGER_IDS.map((id) => (
                <option key={id} value={id}>{ti(id)}</option>
              ))}
            </optgroup>
          </select>
          {members.length > 1 && (
            <select value={creatorFilter} onChange={(e) => setCreatorFilter(e.target.value)} className="h-9 rounded-md border border-border bg-muted px-2 text-sm" aria-label={tc("creator")}>
              <option value="all">{tc("allAgents")}</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>{m.full_name || m.email || m.user_id}</option>
              ))}
            </select>
          )}
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="h-9 rounded-md border border-border bg-muted px-2 text-sm" aria-label={tb("sort")}>
            {(["updated", "newest", "oldest", "name", "runs"] as const).map((k) => (
              <option key={k} value={k}>{tb(`sorts.${k}`)}</option>
            ))}
          </select>
          <div className="flex rounded-lg border border-border p-0.5">
            <button type="button" aria-label={tb("cards")} title={tb("cards")} onClick={() => chooseView("cards")} className={cn("rounded-md p-1.5", view === "cards" ? "bg-primary/10 text-primary" : "text-muted-foreground")}>
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button type="button" aria-label={tb("table")} title={tb("table")} onClick={() => chooseView("table")} className={cn("rounded-md p-1.5", view === "table" ? "bg-primary/10 text-primary" : "text-muted-foreground")}>
              <ListIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {flows.length === 0 ? (
        <EmptyState
          onCreate={() => setCreateOpen(true)}
          canCreate={canCreate}
          t={t}
        />
      ) : visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">{tb("noMatch")}</p>
      ) : view === "table" ? (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                {["name", "status", "trigger", "runs", "updated"].map((c) => (
                  <th key={c} className="whitespace-nowrap px-3 py-2 font-medium">{tb(`cols.${c}`)}</th>
                ))}
                <th className="whitespace-nowrap px-3 py-2 font-medium">{tc("creator")}</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map((flow) => (
                <tr key={flow.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <button type="button" className="font-medium hover:underline" onClick={() => router.push(`/flows/${flow.id}`)}>{flow.name}</button>
                    {flow.has_unpublished_changes && <span className="ml-2 text-[10px] text-amber-600">{tb("unpublished")}</span>}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className={cn("text-[10px]", STATUS_COLORS[flow.status])}>{STATUS_LABELS(t)[flow.status]}</Badge>
                  </td>
                  <td className="max-w-[260px] truncate px-3 py-2 text-muted-foreground">{describeTrigger(flow, t, ti)}</td>
                  <td className="px-3 py-2 tabular-nums">
                    <Link href={`/flows/${flow.id}/runs`} className="text-primary hover:underline">{flow.execution_count}</Link>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{new Date(flow.updated_at).toLocaleString()}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{memberName(flow.user_id)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <Button variant="ghost" size="sm" onClick={() => router.push(`/flows/${flow.id}/runs`)} aria-label={tc("logs")} title={tc("logs")}>
                      <ScrollText className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(flow)} className="text-red-400 hover:bg-red-500/10" aria-label={t("delete")}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((flow) => (
            <FlowCard
              key={flow.id}
              flow={flow}
              onEdit={() => router.push(`/flows/${flow.id}`)}
              onDelete={() => handleDelete(flow)}
              t={t}
            />
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        {/* `sm:max-w-4xl` not `max-w-4xl` — shadcn's DialogContent has
            `sm:max-w-sm` baked into its default classes. Without the
            sm: prefix our override applies at base only and the
            sm-scoped 384px wins at every real desktop breakpoint. */}
        <DialogContent className="sm:max-w-4xl bg-popover text-popover-foreground">
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("createDesc")}
            </DialogDescription>
          </DialogHeader>

          {templates.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("startTemplate")}
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((template) => {
                  const Icon = TEMPLATE_ICONS[template.icon] ?? FileText;
                  return (
                    <button
                      key={template.slug}
                      type="button"
                      onClick={() => handleUseTemplate(template.slug)}
                      disabled={creating}
                      className="flex flex-col gap-2.5 rounded-lg border border-border bg-background p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted disabled:opacity-50"
                    >
                      <Icon className="h-5 w-5 text-primary" />
                      <span className="text-sm font-semibold text-popover-foreground">
                        {template.name}
                      </span>
                      <span className="text-xs leading-relaxed text-muted-foreground">
                        {template.description}
                      </span>
                      <span className="mt-auto border-t border-border pt-2 text-[11px] text-muted-foreground">
                        {t("nodeCount", { count: template.node_count })}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {t("startBlank")}
            </p>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("placeholderName")}
              className="bg-muted"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              {t("cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || creating}>
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("createBlank")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState({
  onCreate,
  canCreate,
  t,
}: {
  onCreate: () => void;
  canCreate: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
        <Workflow className="h-6 w-6 text-muted-foreground" />
      </div>
      <h2 className="mt-4 text-base font-medium text-foreground">
        {t("emptyTitle")}
      </h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        {t("emptyDesc")}
      </p>
      <GatedButton
        canAct={canCreate}
        gateReason="create flows"
        onClick={onCreate}
        className="mt-5"
      >
        <Plus className="h-4 w-4" />
        {t("createFirst")}
      </GatedButton>
    </div>
  );
}

function FlowCard({
  flow,
  onEdit,
  onDelete,
  t,
}: {
  flow: FlowRow;
  onEdit: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const ti = useTranslations("BotStudio.builder.items");
  const triggerSummary = describeTrigger(flow, t, ti);
  const tUnpub = useTranslations("BotStudio.lists");
  const StatusIcon =
    flow.status === "active"
      ? PlayCircle
      : flow.status === "archived"
        ? Archive
        : PauseCircle;
  return (
    <div className="flex flex-col rounded-lg border border-border bg-card p-4 transition-colors hover:border-border">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Workflow className="h-4 w-4 shrink-0 text-primary" />
          <h3 className="truncate text-sm font-semibold text-foreground">
            {flow.name}
          </h3>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "shrink-0 gap-1 text-[10px]",
            STATUS_COLORS[flow.status],
          )}
        >
          <StatusIcon className="h-3 w-3" />
          {STATUS_LABELS(t)[flow.status]}
        </Badge>
      </div>

      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
        {flow.description || triggerSummary}
      </p>

      <div className="mt-4 flex items-center gap-3 text-[11px] text-muted-foreground">
        <Link href={`/flows/${flow.id}/runs`} className="inline-flex items-center gap-1 hover:text-primary">
          <MessageSquare className="h-3 w-3" />
          {t("runCount", { count: flow.execution_count })}
        </Link>
        <span>· {new Date(flow.updated_at).toLocaleDateString()}</span>
        {flow.has_unpublished_changes && <span className="text-amber-600">· {tUnpub("unpublished")}</span>}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-border pt-3">
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" />
          {t("edit")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("delete")}
        </Button>
      </div>
    </div>
  );
}

/** Event triggers a flow can have (one Flow, migration 048). */
const EVENT_TRIGGER_IDS = TRIGGER_SECTIONS.flatMap((s) => s.items)
  .filter((i) => i.kind === "trigger" && !["keyword", "first_inbound_message", "manual"].includes(i.id))
  .map((i) => i.id);

function describeTrigger(
  flow: FlowRow,
  t: ReturnType<typeof useTranslations>,
  ti: ReturnType<typeof useTranslations>,
): string {
  if (flow.trigger_type === "keyword") {
    const keywords = Array.isArray(flow.trigger_config.keywords)
      ? (flow.trigger_config.keywords as string[])
      : [];
    if (keywords.length === 0) return t("triggerKeywordNone");
    return t("triggerKeyword", { keywords: keywords.join(", ") });
  }
  if (flow.trigger_type === "first_inbound_message") {
    return t("triggerFirstInbound");
  }
  if (flow.trigger_type !== "manual") return ti(flow.trigger_type);
  return t("triggerManual");
}
