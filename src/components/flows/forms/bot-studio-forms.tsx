"use client";

/**
 * Settings forms for the Bot Studio flow nodes (migration 047) and the
 * new options on two original nodes (collect_input validation, handoff
 * agent). Edits go through `onUpdateConfig` like every other form.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { createClient } from "@/lib/supabase/client";
import { VariablePicker, type ExtraVariable } from "@/components/bot/variable-picker";
import type { BuilderNode } from "../shared";
import { NextNodeRow, TextRow } from "./fields";

const SELECT =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none";
const ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"];

interface Props {
  node: BuilderNode;
  allNodes: BuilderNode[];
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}

/** {{vars.x}} the flow captures before this point (collect_input / format / AI). */
export function flowVariables(nodes: BuilderNode[]): ExtraVariable[] {
  const keys = new Set<string>();
  for (const n of nodes) {
    const c = n.config as Record<string, unknown>;
    if (n.node_type === "collect_input" && typeof c.var_key === "string" && c.var_key) keys.add(c.var_key);
    if ((n.node_type === "format_value" || n.node_type === "ai_reply") && typeof c.output_var === "string" && c.output_var) keys.add(c.output_var);
    if (n.node_type === "send_message" && typeof c.reply_var === "string" && c.reply_var) keys.add(c.reply_var);
    if (n.node_type === "call_api") {
      keys.add("api_status");
      if (typeof c.response_var === "string" && c.response_var) keys.add(c.response_var);
    }
    if ((n.node_type === "send_buttons" || n.node_type === "send_list") && c.other_next) keys.add("last_reply");
    if (n.node_type === "google_sheets") keys.add("sheet_row");
  }
  return [...keys].map((k) => ({ token: `vars.${k}` }));
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="mb-1 block text-xs text-muted-foreground">{children}</label>;
}

function VarInput({
  label,
  value,
  onChange,
  vars,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  vars: ExtraVariable[];
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex gap-1">
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={`bg-muted text-xs ${mono ? "font-mono" : ""}`} />
        <VariablePicker extra={vars} onInsert={(tok) => onChange(`${value}${tok}`)} />
      </div>
    </div>
  );
}

function useMembers() {
  const [members, setMembers] = useState<{ user_id: string; full_name?: string; email?: string; role?: string }[]>([]);
  useEffect(() => {
    void fetch("/api/account/members", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { members: [] }))
      .then((j: { members?: typeof members }) => setMembers((j.members ?? []).filter((m) => m.role !== "viewer")));
  }, []);
  return members;
}

function useTemplates() {
  const [rows, setRows] = useState<{ id: string; name: string; language?: string; body_text: string; header_type?: string }[]>([]);
  useEffect(() => {
    void createClient()
      .from("message_templates")
      .select("id, name, language, body_text, header_type")
      .eq("status", "APPROVED")
      .order("name")
      .then(({ data }) => setRows((data ?? []) as typeof rows));
  }, []);
  return rows;
}

function useCustomFields() {
  const [rows, setRows] = useState<{ id: string; field_name: string }[]>([]);
  useEffect(() => {
    void createClient()
      .from("custom_fields")
      .select("id, field_name")
      .order("field_name")
      .then(({ data }) => setRows((data ?? []) as typeof rows));
  }, []);
  return rows;
}

export function BotStudioNodeForm({ node, allNodes, onUpdateConfig }: Props) {
  const t = useTranslations("BotStudio.flows.form");
  const tf = useTranslations("Flows.builder.form");
  const cfg = node.config as Record<string, unknown>;
  const s = (k: string) => (typeof cfg[k] === "string" ? (cfg[k] as string) : cfg[k] == null ? "" : String(cfg[k]));
  const vars = flowVariables(allNodes);
  const members = useMembers();
  const templates = useTemplates();
  const customFields = useCustomFields();
  const next = (key: string, label: string) => (
    <NextNodeRow value={s(key)} allNodes={allNodes} currentKey={node.node_key} onChange={(v) => onUpdateConfig({ [key]: v })} label={label} />
  );

  switch (node.node_type) {
    case "send_location":
      return (
        <>
          <div className="grid grid-cols-2 gap-2">
            <VarInput label={t("latitude")} value={s("latitude")} onChange={(v) => onUpdateConfig({ latitude: v })} vars={vars} placeholder="18.5204" />
            <VarInput label={t("longitude")} value={s("longitude")} onChange={(v) => onUpdateConfig({ longitude: v })} vars={vars} placeholder="73.8567" />
          </div>
          <VarInput label={t("placeName")} value={s("name")} onChange={(v) => onUpdateConfig({ name: v })} vars={vars} />
          <VarInput label={t("address")} value={s("address")} onChange={(v) => onUpdateConfig({ address: v })} vars={vars} />
          <p className="text-[11px] text-muted-foreground">{t("windowNote")}</p>
          {next("next_node_key", tf("advancesTo"))}
        </>
      );

    case "send_template": {
      const current = templates.find((tp) => tp.name === s("template_name") && (tp.language ?? "") === s("language"));
      const varCount = new Set((current?.body_text ?? "").match(/\{\{\s*\d+\s*\}\}/g) ?? []).size;
      const params = Array.isArray(cfg.params) ? (cfg.params as string[]) : [];
      return (
        <>
          <div>
            <Label>{t("template")}</Label>
            <select
              value={`${s("template_name")}::${s("language")}`}
              onChange={(e) => {
                const [name, language] = e.target.value.split("::");
                onUpdateConfig({ template_name: name, language, params: [] });
              }}
              className={SELECT}
            >
              <option value="::">{t("pickTemplate")}</option>
              {templates.map((tp) => (
                <option key={tp.id} value={`${tp.name}::${tp.language ?? ""}`}>
                  {tp.name} ({tp.language})
                </option>
              ))}
              {s("template_name") && !current && (
                <option value={`${s("template_name")}::${s("language")}`}>{t("templateMissing", { name: s("template_name") })}</option>
              )}
            </select>
          </div>
          {current && <p className="rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{current.body_text}</p>}
          {Array.from({ length: varCount }, (_, i) => (
            <VarInput
              key={i}
              label={t("param", { n: i + 1 })}
              value={params[i] ?? ""}
              onChange={(v) => {
                const nextParams = [...params];
                while (nextParams.length < varCount) nextParams.push("");
                nextParams[i] = v;
                onUpdateConfig({ params: nextParams });
              }}
              vars={vars}
            />
          ))}
          {current?.header_type && ["image", "video", "document"].includes(current.header_type) && (
            <VarInput label={t("headerMedia")} value={s("header_media_url")} onChange={(v) => onUpdateConfig({ header_media_url: v })} vars={vars} placeholder="https://" />
          )}
          {next("next_node_key", tf("advancesTo"))}
        </>
      );
    }

    case "assign_agent": {
      const pool = Array.isArray(cfg.pool) ? (cfg.pool as string[]) : [];
      return (
        <>
          <div>
            <Label>{t("assignMode")}</Label>
            <select value={s("mode") || "round_robin"} onChange={(e) => onUpdateConfig({ mode: e.target.value })} className={SELECT}>
              <option value="round_robin">{t("modes.round_robin")}</option>
              <option value="random">{t("modes.random")}</option>
              <option value="specific">{t("modes.specific")}</option>
              <option value="last_agent">{t("modes.last_agent")}</option>
            </select>
          </div>
          {s("mode") === "specific" ? (
            <div>
              <Label>{t("agent")}</Label>
              <select value={s("agent_id")} onChange={(e) => onUpdateConfig({ agent_id: e.target.value })} className={SELECT}>
                <option value="">{t("pickAgent")}</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>{m.full_name || m.email || m.user_id}</option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <Label>{t("pool")}</Label>
              <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                {members.map((m) => (
                  <label key={m.user_id} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={pool.includes(m.user_id)}
                      onChange={(e) => onUpdateConfig({ pool: e.target.checked ? [...pool, m.user_id] : pool.filter((x) => x !== m.user_id) })}
                    />
                    {m.full_name || m.email || m.user_id}
                  </label>
                ))}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{t("poolHint")}</p>
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={cfg.reassign === true} onCheckedChange={(v) => onUpdateConfig({ reassign: !!v })} />
            {t("reassign")}
          </label>
          <p className="text-[11px] text-muted-foreground">{t("assignNotHandoff")}</p>
          {next("next_node_key", tf("advancesTo"))}
        </>
      );
    }

    case "set_field":
      return (
        <>
          <div>
            <Label>{t("attribute")}</Label>
            <select value={s("field")} onChange={(e) => onUpdateConfig({ field: e.target.value })} className={SELECT}>
              <option value="">{t("pickAttribute")}</option>
              <option value="name">{t("fields.name")}</option>
              <option value="email">{t("fields.email")}</option>
              <option value="company">{t("fields.company")}</option>
              {customFields.map((f) => (
                <option key={f.id} value={`custom:${f.id}`}>{f.field_name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 text-xs">
            {(["set", "clear"] as const).map((m) => (
              <label key={m} className="flex items-center gap-1">
                <input type="radio" checked={(s("mode") || "set") === m} onChange={() => onUpdateConfig({ mode: m })} />
                {t(`fieldModes.${m}`)}
              </label>
            ))}
          </div>
          {(s("mode") || "set") === "set" && (
            <VarInput label={t("value")} value={s("value")} onChange={(v) => onUpdateConfig({ value: v })} vars={vars} />
          )}
          {next("next_node_key", tf("advancesTo"))}
        </>
      );

    case "working_hours":
      return (
        <>
          <p className="text-[11px] text-muted-foreground">
            {t("hoursHint")}{" "}
            <a className="text-primary hover:underline" href="/settings?tab=inbox#business-hours">{t("hoursLink")}</a>
          </p>
          {next("open_next", t("slotOpen"))}
          {next("closed_next", t("slotClosed"))}
          {next("holiday_next", t("slotHoliday"))}
        </>
      );

    case "opt_out":
      return (
        <>
          <p className="text-[11px] text-muted-foreground">{t("optOutHint")}</p>
          {next("next_node_key", tf("advancesTo"))}
        </>
      );

    case "format_value":
      return (
        <>
          <div>
            <Label>{t("formatKind")}</Label>
            <select value={s("kind") || "date"} onChange={(e) => onUpdateConfig({ kind: e.target.value })} className={SELECT}>
              <option value="date">{t("formatDate")}</option>
              <option value="phone">{t("formatPhone")}</option>
            </select>
          </div>
          <VarInput label={t("input")} value={s("input")} onChange={(v) => onUpdateConfig({ input: v })} vars={vars} placeholder="{{vars.visit_date}}" mono />
          {(s("kind") || "date") === "date" ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>{t("inputFormat")}</Label>
                  <select value={s("input_format") || "auto"} onChange={(e) => onUpdateConfig({ input_format: e.target.value })} className={SELECT}>
                    {["auto", "dmy", "mdy", "iso", "epoch_ms", "epoch_s"].map((f) => <option key={f} value={f}>{t(`inputFormats.${f}`)}</option>)}
                  </select>
                </div>
                <div>
                  <Label>{t("timezone")}</Label>
                  <select value={s("output_timezone") || "Asia/Kolkata"} onChange={(e) => onUpdateConfig({ output_timezone: e.target.value, input_timezone: s("input_timezone") || e.target.value })} className={SELECT}>
                    {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <Label>{t("outputFormat")}</Label>
                <Input value={s("output_format")} onChange={(e) => onUpdateConfig({ output_format: e.target.value })} placeholder="DD MMM YYYY, hh:mm A" className="bg-muted font-mono text-xs" />
              </div>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>{t("country")}</Label>
                <Input value={s("default_country_code")} onChange={(e) => onUpdateConfig({ default_country_code: e.target.value.replace(/\D/g, "") })} placeholder="91" className="bg-muted text-xs" />
              </div>
              <div>
                <Label>{t("phoneOutput")}</Label>
                <select value={s("phone_output") || "e164"} onChange={(e) => onUpdateConfig({ phone_output: e.target.value })} className={SELECT}>
                  <option value="e164">+919876543210</option>
                  <option value="digits">919876543210</option>
                  <option value="national">9876543210</option>
                </select>
              </div>
            </div>
          )}
          <div>
            <Label>{t("outputVar")}</Label>
            <Input value={s("output_var")} onChange={(e) => onUpdateConfig({ output_var: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })} className="bg-muted font-mono text-xs" />
          </div>
          {next("next_node_key", tf("advancesTo"))}
          {next("error_next", t("slotError"))}
        </>
      );

    case "ai_reply":
      return (
        <>
          <p className="text-[11px] text-muted-foreground">{t("aiHint")}</p>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={cfg.send !== false} onCheckedChange={(v) => onUpdateConfig({ send: !!v })} />
            {t("aiSend")}
          </label>
          <div>
            <Label>{t("aiOutputVar")}</Label>
            <Input value={s("output_var")} onChange={(e) => onUpdateConfig({ output_var: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })} placeholder="ai_answer" className="bg-muted font-mono text-xs" />
          </div>
          <TextRow label={t("aiInstruction")} value={s("instruction")} onChange={(v) => onUpdateConfig({ instruction: v })} rows={2} />
          {next("next_node_key", tf("advancesTo"))}
          {next("handoff_next", t("slotHandoff"))}
        </>
      );

    default:
      return <p className="text-xs text-amber-600">{t("unknownNode")}</p>;
  }
}

/** Extra options for collect_input (opt-in validation). */
export function CollectInputValidation({ cfg, onUpdateConfig }: { cfg: Record<string, unknown>; onUpdateConfig: (p: Record<string, unknown>) => void }) {
  const t = useTranslations("BotStudio.flows.form");
  const enforce = cfg.enforce_validation === true;
  return (
    <div className="space-y-2 rounded-md border border-border p-2">
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch checked={enforce} onCheckedChange={(v) => onUpdateConfig({ enforce_validation: !!v })} />
        {t("validate")}
      </label>
      {enforce && (
        <>
          <select value={(cfg.validation as string) || "any"} onChange={(e) => onUpdateConfig({ validation: e.target.value })} className={SELECT}>
            {["any", "email", "phone", "number", "regex"].map((v) => <option key={v} value={v}>{t(`validations.${v}`)}</option>)}
          </select>
          {cfg.validation === "regex" && (
            <Input value={(cfg.regex as string) ?? ""} onChange={(e) => onUpdateConfig({ regex: e.target.value })} placeholder="^[1-5]BHK$" className="bg-muted font-mono text-xs" />
          )}
          <TextRow label={t("invalidText")} value={(cfg.invalid_text as string) ?? ""} onChange={(v) => onUpdateConfig({ invalid_text: v })} rows={2} />
          <p className="text-[11px] text-muted-foreground">{t("validateHint")}</p>
        </>
      )}
    </div>
  );
}

/** Optional agent for the Handoff node (the engine always supported it). */
export function HandoffAssignee({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useTranslations("BotStudio.flows.form");
  const members = useMembers();
  return (
    <div>
      <Label>{t("handoffAgent")}</Label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={SELECT}>
        <option value="">{t("handoffQueue")}</option>
        {members.map((m) => (
          <option key={m.user_id} value={m.user_id}>{m.full_name || m.email || m.user_id}</option>
        ))}
      </select>
    </div>
  );
}
