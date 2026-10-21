"use client";

/**
 * Test / Simulate: runs the CURRENT DRAFT with synthetic input, a fake
 * clock and mocked actions (nothing is sent, assigned or stored). Also
 * asks the server "who would answer this message now?" against the
 * account's live configuration (read-only).
 */

import { useMemo, useState } from "react";
import { FlaskConical, RotateCcw, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { simulateFlow, type SimInput } from "@/lib/flows/simulate";
import type { ExplainResult } from "@/lib/bot/explain";
import { useFlowEditor } from "./flow-editor-state";

function localNow(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function SimulatorSheet() {
  const t = useTranslations("BotStudio.flows.sim");
  const { state } = useFlowEditor();
  const [inputs, setInputs] = useState<SimInput[]>([]);
  const [draft, setDraft] = useState("");
  const [clock, setClock] = useState(localNow);
  const [name, setName] = useState("Test Customer");
  const [phone, setPhone] = useState("9000000001");
  const [aiText, setAiText] = useState("");
  const [aiHandoff, setAiHandoff] = useState(false);
  const [firstInbound, setFirstInbound] = useState(true);
  const [explain, setExplain] = useState<ExplainResult | null>(null);

  const result = useMemo(
    () =>
      simulateFlow(
        {
          trigger_type: state.trigger_type,
          trigger_config: state.trigger_config,
          entry_node_id: state.entry_node_id,
          fallback_policy: state.fallback_policy,
        },
        state.nodes,
        inputs,
        {
          now: new Date(clock),
          contact: { name, phone },
          tagIds: [],
          custom: {},
          ai: { text: aiText || t("aiDefault"), handoff: aiHandoff },
          firstInbound,
        },
      ),
    [state, inputs, clock, name, phone, aiText, aiHandoff, firstInbound, t],
  );

  const waitingPrompt = [...result.steps].reverse().find((s) => s.kind === "prompt");

  async function send(input: SimInput) {
    setInputs((prev) => [...prev, input]);
    if (inputs.length === 0 && input.kind === "text") {
      const res = await fetch(`/api/bot-studio/explain?text=${encodeURIComponent(input.text)}&first=${firstInbound ? 1 : 0}`, { cache: "no-store" });
      setExplain(res.ok ? ((await res.json()) as ExplainResult) : null);
    }
  }

  return (
    <Sheet>
      <SheetTrigger render={<Button variant="outline" size="sm" />}>
        <FlaskConical className="h-3.5 w-3.5" />
        {t("open")}
      </SheetTrigger>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle>{t("title")}</SheetTitle>
          <SheetDescription>{t("subtitle")}</SheetDescription>
        </SheetHeader>

        <details className="border-b border-border px-5 py-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">{t("context")}</summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-muted-foreground">{t("clock")}</span>
              <Input type="datetime-local" value={clock} onChange={(e) => setClock(e.target.value)} className="bg-muted text-xs" />
            </label>
            <label className="space-y-1">
              <span className="text-muted-foreground">{t("name")}</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="bg-muted text-xs" />
            </label>
            <label className="space-y-1">
              <span className="text-muted-foreground">{t("phone")}</span>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="bg-muted text-xs" />
            </label>
            <label className="space-y-1">
              <span className="text-muted-foreground">{t("aiAnswer")}</span>
              <Input value={aiText} onChange={(e) => setAiText(e.target.value)} placeholder={t("aiDefault")} className="bg-muted text-xs" />
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={aiHandoff} onCheckedChange={(v) => setAiHandoff(!!v)} />
              {t("aiHandoff")}
            </label>
            <label className="flex items-center gap-2">
              <Switch checked={firstInbound} onCheckedChange={(v) => setFirstInbound(!!v)} />
              {t("firstMessage")}
            </label>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">{t("mockNote")}</p>
        </details>

        <div className="flex-1 space-y-2 overflow-y-auto px-5 py-4 text-sm">
          {inputs.length === 0 && <p className="text-muted-foreground text-xs">{t("start")}</p>}
          {(() => {
            const out: React.ReactNode[] = [];
            let inputIx = 0;
            for (const [i, s] of result.steps.entries()) {
              if (s.kind === "start" && inputs[0]) {
                const first = inputs[inputIx++];
                out.push(<Bubble key={`in-${i}`} side="customer">{first.kind === "text" ? first.text : first.title ?? first.reply_id}</Bubble>);
              }
              if (s.kind === "input") {
                inputIx++;
                out.push(<Bubble key={i} side="customer">{s.detail}</Bubble>);
              } else if (s.kind === "message" || s.kind === "prompt") {
                out.push(
                  <Bubble key={i} side="bot" node={s.node_key}>
                    {s.detail || "…"}
                    {s.options?.length ? <span className="mt-1 block text-[11px] opacity-70">[{s.options.map((o) => o.title).join(" · ")}]</span> : null}
                  </Bubble>,
                );
              } else if (s.kind !== "start") {
                out.push(
                  <p key={i} className={`text-[11px] ${s.kind === "error" ? "text-red-500" : "text-muted-foreground"}`}>
                    {s.node_key ? <code className="mr-1">{s.node_key}</code> : null}
                    {t(`kinds.${s.kind}`)}: {s.detail}
                  </p>,
                );
              }
            }
            if (result.steps.length === 0 && inputs[0]) {
              const first = inputs[0];
              out.push(<Bubble key="first" side="customer">{first.kind === "text" ? first.text : first.reply_id}</Bubble>);
            }
            return out;
          })()}
          {inputs.length > 0 && (
            <p className="pt-2 text-xs font-medium">
              {t(`status.${result.status}`)}
              {result.waitingAt ? ` — ${result.waitingAt}` : ""}
            </p>
          )}
          {Object.keys(result.vars).length > 0 && (
            <pre className="rounded-md bg-muted p-2 text-[11px]">{JSON.stringify(result.vars, null, 2)}</pre>
          )}
          {explain && (
            <div className="space-y-1 rounded-md border border-border p-2 text-[11px]">
              <p className="font-medium">{t("whoAnswers")}</p>
              {explain.lines.map((l, i) => (
                <p key={i} className="text-muted-foreground">• {t(`explain.${l.key}`, l as never)}</p>
              ))}
              {explain.overlaps.map((o, i) => (
                <p key={`o${i}`} className="text-amber-600 dark:text-amber-400">⚠ {t("overlap", o)}</p>
              ))}
              <p className="text-muted-foreground italic">{t("explainNote")}</p>
            </div>
          )}
        </div>

        <div className="space-y-2 border-t border-border px-5 py-3">
          {result.status === "waiting" && waitingPrompt?.options?.length ? (
            <div className="flex flex-wrap gap-1">
              {waitingPrompt.options.map((o) => (
                <Button key={o.reply_id} size="sm" variant="outline" onClick={() => void send({ kind: "tap", reply_id: o.reply_id, title: o.title })}>
                  {o.title}
                </Button>
              ))}
            </div>
          ) : null}
          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draft.trim()) {
                  void send({ kind: "text", text: draft.trim() });
                  setDraft("");
                }
              }}
              placeholder={t("typeMessage")}
              className="bg-muted"
            />
            <Button size="sm" disabled={!draft.trim()} onClick={() => { void send({ kind: "text", text: draft.trim() }); setDraft(""); }} aria-label={t("send")}>
              <Send className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setInputs([]); setExplain(null); }} aria-label={t("reset")} title={t("reset")}>
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Bubble({ side, node, children }: { side: "customer" | "bot"; node?: string; children: React.ReactNode }) {
  return (
    <div className={`flex ${side === "customer" ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${side === "customer" ? "bg-primary/15" : "bg-muted"}`}>
        {children}
        {node && <span className="mt-1 block font-mono text-[10px] opacity-60">{node}</span>}
      </div>
    </div>
  );
}
