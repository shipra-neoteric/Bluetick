"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ArrowLeft,
  ChevronDown,
  Plus,
  Trash2,
  GripVertical,
  MessageSquare,
  FileText,
  Tag,
  TagIcon,
  UserCheck,
  PencilLine,
  Briefcase,
  Hourglass,
  GitBranch,
  Webhook,
  CircleSlash,
  Zap,
  Loader2,
  ArrowDown,
  ArrowUp,
  MousePointerClick,
  List,
  MapPin,
  BellOff,
  CalendarClock,
  CalendarDays,
  Phone,
  Workflow,
  Copy,
  RefreshCw,
  Radar,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { VariablePicker } from "@/components/bot/variable-picker"
import type {
  AccountMember,
  AutomationStepType,
  AutomationTriggerType,
  CustomField,
  InteractiveMessagePayload,
  KeywordMatchTriggerConfig,
  MessageTemplate,
  Tag as TagRecord,
} from "@/types"
import {
  InteractiveBuilder,
  blankButtonsPayload,
  blankListPayload,
} from "@/components/interactive/interactive-builder"
import { interactivePayloadPreviewText } from "@/lib/whatsapp/interactive"
import { createClient } from "@/lib/supabase/client"
import {
  childPath,
  insertAt,
  mapAtPath,
  moveAt,
  removeAt,
  type ParentScope,
  type StepPath,
} from "@/lib/automations/builder-tree"
import { cn } from "@/lib/utils"

// ------------------------------------------------------------
// Types (builder-local — mirror the flattened rows we POST)
// ------------------------------------------------------------

export interface BuilderStep {
  /** Client id; the API assigns real UUIDs server-side. */
  cid: string
  step_type: AutomationStepType
  step_config: Record<string, unknown>
  branches?: { yes: BuilderStep[]; no: BuilderStep[] }
}

export interface BuilderInitial {
  id?: string
  name: string
  description: string
  trigger_type: AutomationTriggerType
  trigger_config: Record<string, unknown>
  is_active: boolean
  steps: BuilderStep[]
}

// ------------------------------------------------------------
// Step metadata — one source of truth for icon + label + border color
// ------------------------------------------------------------

interface StepMeta {
  label: string
  icon: typeof Zap
  /** Left-border accent color per spec. */
  border: string
}

const STEP_META: Record<AutomationStepType, StepMeta> = {
  send_message: { label: "send_message", icon: MessageSquare, border: "border-l-primary" },
  send_buttons: { label: "send_buttons", icon: MousePointerClick, border: "border-l-primary" },
  send_list: { label: "send_list", icon: List, border: "border-l-primary" },
  send_template: { label: "send_template", icon: FileText, border: "border-l-primary" },
  add_tag: { label: "add_tag", icon: Tag, border: "border-l-primary" },
  remove_tag: { label: "remove_tag", icon: TagIcon, border: "border-l-primary" },
  assign_conversation: { label: "assign_conversation", icon: UserCheck, border: "border-l-primary" },
  update_contact_field: { label: "update_contact_field", icon: PencilLine, border: "border-l-primary" },
  create_deal: { label: "create_deal", icon: Briefcase, border: "border-l-primary" },
  wait: { label: "wait", icon: Hourglass, border: "border-l-border" },
  condition: { label: "condition", icon: GitBranch, border: "border-l-amber-500" },
  send_webhook: { label: "send_webhook", icon: Webhook, border: "border-l-primary" },
  close_conversation: { label: "close_conversation", icon: CircleSlash, border: "border-l-primary" },
  // Bot Studio steps — labels live under BotStudio.automation.steps.
  send_location: { label: "send_location", icon: MapPin, border: "border-l-primary" },
  opt_out: { label: "opt_out", icon: BellOff, border: "border-l-rose-500" },
  wait_until: { label: "wait_until", icon: CalendarClock, border: "border-l-border" },
  format_date: { label: "format_date", icon: CalendarDays, border: "border-l-violet-500" },
  format_phone: { label: "format_phone", icon: Phone, border: "border-l-violet-500" },
  start_flow: { label: "start_flow", icon: Workflow, border: "border-l-emerald-500" },
}

/** Steps added by Bot Studio (translated from BotStudio.automation). */
const NEW_STEPS = new Set<AutomationStepType>([
  "send_location", "opt_out", "wait_until", "format_date", "format_phone", "start_flow",
])

/** Palette groups. Every original step is still here. */
const STEP_GROUPS: { id: string; steps: AutomationStepType[] }[] = [
  { id: "messaging", steps: ["send_message", "send_buttons", "send_list", "send_template", "send_location"] },
  { id: "customer", steps: ["add_tag", "remove_tag", "update_contact_field", "assign_conversation", "opt_out", "close_conversation", "create_deal"] },
  { id: "time", steps: ["wait", "wait_until"] },
  { id: "logic", steps: ["condition", "format_date", "format_phone"] },
  { id: "integrations", steps: ["send_webhook", "start_flow"] },
]

/** Triggers added by Bot Studio (translated from BotStudio.automation). */
const NEW_TRIGGERS = new Set<AutomationTriggerType>([
  "conversation_opened", "conversation_closed", "contact_field_changed", "first_daily_message",
  "no_keyword_match", "ctwa_message", "template_delivered", "sla_breached", "incoming_webhook",
])

const TRIGGER_GROUPS: { id: string; triggers: AutomationTriggerType[] }[] = [
  { id: "messages", triggers: ["new_message_received", "first_inbound_message", "first_daily_message", "keyword_match", "no_keyword_match", "interactive_reply", "ctwa_message"] },
  { id: "conversation", triggers: ["conversation_opened", "conversation_closed", "conversation_assigned", "sla_breached"] },
  { id: "contact", triggers: ["new_contact_created", "tag_added", "contact_field_changed"] },
  { id: "delivery", triggers: ["template_delivered"] },
  { id: "external", triggers: ["incoming_webhook"] },
  { id: "scheduled", triggers: ["time_based"] },
]

function useLabels() {
  const t = useTranslations("Automations.builder")
  const tb = useTranslations("BotStudio.automation")
  return {
    step: (tp: AutomationStepType) => (NEW_STEPS.has(tp) ? tb(`steps.${tp}`) : t(`steps.${STEP_META[tp].label}`)),
    trigger: (tr: AutomationTriggerType) => (NEW_TRIGGERS.has(tr) ? tb(`triggers.${tr}.label`) : t(`triggers.${tr}.label`)),
    hint: (tr: AutomationTriggerType) => (NEW_TRIGGERS.has(tr) ? tb(`triggers.${tr}.hint`) : t(`triggers.${tr}.hint`)),
    tb,
  }
}


const TRIGGER_OPTIONS: { value: AutomationTriggerType }[] = [
  { value: "new_message_received" },
  { value: "first_inbound_message" },
  { value: "keyword_match" },
  { value: "interactive_reply" },
  { value: "new_contact_created" },
  { value: "conversation_assigned" },
  { value: "tag_added" },
  { value: "time_based" },
]

function cid(): string {
  return (
    "c_" +
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36))
  )
}

// The send_buttons / send_list step_config IS an InteractiveMessagePayload,
// but step_config is typed generically as Record<string, unknown>. These two
// helpers hold the single unavoidable structural cast in one place so a
// payload-shape change has one seam to update instead of four scattered
// `as unknown as` sites.
function toStepConfig(p: InteractiveMessagePayload): Record<string, unknown> {
  return p as unknown as Record<string, unknown>
}
function asInteractive(cfg: Record<string, unknown>): InteractiveMessagePayload {
  return cfg as unknown as InteractiveMessagePayload
}

function blankConfig(type: AutomationStepType): Record<string, unknown> {
  switch (type) {
    case "send_message":
      return { text: "" }
    case "send_buttons":
      return toStepConfig(blankButtonsPayload())
    case "send_list":
      return toStepConfig(blankListPayload())
    case "send_template":
      return { template_name: "", language: "en_US" }
    case "add_tag":
    case "remove_tag":
      return { tag_id: "" }
    case "assign_conversation":
      return { mode: "round_robin" }
    case "update_contact_field":
      return { field: "name", value: "" }
    case "create_deal":
      return { pipeline_id: "", stage_id: "", title: "", value: 0 }
    case "wait":
      return { amount: 1, unit: "hours" }
    case "condition":
      return { subject: "tag_presence", operand: "", value: "" }
    case "send_webhook":
      return { url: "", headers: {}, body_template: "" }
    case "close_conversation":
      return {}
    case "send_location":
      return { latitude: "", longitude: "", name: "", address: "" }
    case "opt_out":
      return {}
    case "wait_until":
      return { at: "", timezone: "Asia/Kolkata", offset_minutes: 0, if_past: "run_now" }
    case "format_date":
      return { input: "", output_var: "formatted_date", input_format: "auto", output_format: "DD MMM YYYY" }
    case "format_phone":
      return { input: "{{contact.phone}}", output_var: "phone", default_country_code: "91", output: "e164" }
    case "start_flow":
      return { flow_id: "", replace_active: false }
    default:
      return {}
  }
}

// ------------------------------------------------------------
// Account resources (tags, members, approved templates, pipelines)
//
// Loaded once at the builder root and shared via context so the
// tag / agent / template pickers below can offer existing resources
// by name instead of asking the user to paste raw UUIDs. Every picker
// falls back to a raw input when its list is empty (fresh account or
// an older deployment), so an automation is always authorable.
// ------------------------------------------------------------

interface AutomationResources {
  tags: TagRecord[]
  members: AccountMember[]
  templates: MessageTemplate[]
  customFields: CustomField[]
  pipelines: PipelineOption[]
  stages: PipelineStageOption[]
  /** Re-read approved templates (after a sync from Meta). */
  reloadTemplates: () => Promise<void>
  /** Re-read tags / broadcast lists (after creating one in a card). */
  reloadTags: () => Promise<void>
}

interface PipelineOption {
  id: string
  name: string
}

interface PipelineStageOption {
  id: string
  name: string
  pipeline_id: string
  position: number
}

const ResourcesContext = createContext<AutomationResources>({
  tags: [],
  members: [],
  templates: [],
  customFields: [],
  pipelines: [],
  stages: [],
  reloadTemplates: async () => {},
  reloadTags: async () => {},
})

function useResources(): AutomationResources {
  return useContext(ResourcesContext)
}

function ResourcesProvider({ children }: { children: ReactNode }) {
  const [tags, setTags] = useState<TagRecord[]>([])
  const [members, setMembers] = useState<AccountMember[]>([])
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [customFields, setCustomFields] = useState<CustomField[]>([])
  const [pipelines, setPipelines] = useState<PipelineOption[]>([])
  const [stages, setStages] = useState<PipelineStageOption[]>([])

  useEffect(() => {
    let cancelled = false
    const supabase = createClient()

    // Tags, templates and custom fields come straight from the DB — RLS
    // scopes them to the caller's account. Only APPROVED templates can
    // actually be sent (anything else 400s at send time), matching the
    // broadcast picker.
    void (async () => {
      const [tagsRes, templatesRes, customFieldsRes, pipelinesRes, stagesRes] =
        await Promise.all([
          supabase.from("tags").select("*").order("name"),
          supabase
            .from("message_templates")
            .select("*")
            .eq("status", "APPROVED")
            .order("name"),
          supabase.from("custom_fields").select("*").order("field_name"),
          supabase.from("pipelines").select("id, name").order("name"),
          supabase
            .from("pipeline_stages")
            .select("id, name, pipeline_id, position")
            .order("position"),
        ])
      if (cancelled) return
      setTags((tagsRes.data as TagRecord[] | null) ?? [])
      setTemplates((templatesRes.data as MessageTemplate[] | null) ?? [])
      setCustomFields((customFieldsRes.data as CustomField[] | null) ?? [])
      setPipelines((pipelinesRes.data as PipelineOption[] | null) ?? [])
      setStages((stagesRes.data as PipelineStageOption[] | null) ?? [])
    })()

    // Members go through the API so we inherit its email-visibility
    // rules (agents/viewers don't see emails). Unreachable on older
    // deployments → pickers fall back to a raw agent-id input.
    void (async () => {
      try {
        const res = await fetch("/api/account/members", { cache: "no-store" })
        if (!res.ok) return
        const json = (await res.json()) as { members?: AccountMember[] }
        if (!cancelled) setMembers(json.members ?? [])
      } catch {
        // Members endpoint absent — caller falls back to raw input.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const reloadTemplates = useCallback(async () => {
    const { data } = await createClient()
      .from("message_templates")
      .select("*")
      .eq("status", "APPROVED")
      .order("name")
    setTemplates((data as MessageTemplate[] | null) ?? [])
  }, [])

  const reloadTags = useCallback(async () => {
    const { data } = await createClient().from("tags").select("*").order("name")
    setTags((data as TagRecord[] | null) ?? [])
  }, [])

  return (
    <ResourcesContext.Provider
      value={{ tags, members, templates, customFields, pipelines, stages, reloadTemplates, reloadTags }}
    >
      {children}
    </ResourcesContext.Provider>
  )
}

const SELECT_CLASS =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"

/** Tag dropdown by name + color, storing the tag's id. Falls back to a
 *  raw id input when no tags exist yet. */
function TagSelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { tags } = useResources()
  if (tags.length === 0) {
    return (
      <Input
        placeholder={t("tags.placeholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = tags.find((t) => t.id === value)
  return (
    <div className="flex items-center gap-2">
      <span
        className="h-3 w-3 shrink-0 rounded-full border border-border"
        style={{ backgroundColor: selected?.color ?? "transparent" }}
        aria-hidden
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={SELECT_CLASS}
      >
        <option value="">{t("tags.select")}</option>
        {tags.map((tg) => (
          <option key={tg.id} value={tg.id}>
            {tg.name}
          </option>
        ))}
        {/* Preserve a saved tag that's since been deleted so editing an
            existing automation doesn't silently drop it. */}
        {value && !selected && (
          <option value={value}>{t("tags.unknown", { id: value })}</option>
        )}
      </select>
    </div>
  )
}

/** Contact-field dropdown for "Update Contact Field": built-in columns plus
 *  any account custom fields (stored as `custom:<id>`). A saved custom field
 *  that's since been deleted is preserved as a labelled option so editing an
 *  existing automation doesn't silently drop it. */
function ContactFieldSelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { customFields } = useResources()
  const customValue = value.startsWith("custom:") ? value : ""
  const knownCustom =
    customValue && customFields.some((f) => `custom:${f.id}` === customValue)
  return (
    <select
      value={value || "name"}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="name">{t("fields.name")}</option>
      <option value="email">{t("fields.email")}</option>
      <option value="company">{t("fields.company")}</option>
      {customFields.length > 0 && (
        <optgroup label={t("fields.customFields")}>
          {customFields.map((f) => (
            <option key={f.id} value={`custom:${f.id}`}>
              {f.field_name}
            </option>
          ))}
        </optgroup>
      )}
      {customValue && !knownCustom && (
        <option value={customValue}>{t("fields.unknown", { id: customValue })}</option>
      )}
    </select>
  )
}

/** Agent dropdown by name, storing the member's user_id. Falls back to
 *  a raw id input when the member list is unavailable. */
function AgentSelect({
  value,
  onChange,
  t,
}: {
  value: string
  onChange: (v: string) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { members } = useResources()
  if (members.length === 0) {
    return (
      <Input
        placeholder={t("agents.placeholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-muted text-foreground"
      />
    )
  }
  const selected = members.find((m) => m.user_id === value)
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      <option value="">{t("agents.select")}</option>
      {members.map((m) => (
        <option key={m.user_id} value={m.user_id}>
          {m.full_name || m.email || m.user_id}
        </option>
      ))}
      {value && !selected && (
        <option value={value}>{t("agents.unknown", { id: value })}</option>
      )}
    </select>
  )
}

/** Pipeline + stage picker for Create Deal. The automation stores ids because
 *  the engine writes directly to deals, but authors should choose by name. */
function DealPipelineFields({
  pipelineId,
  stageId,
  onChange,
  t,
}: {
  pipelineId: string
  stageId: string
  onChange: (patch: { pipeline_id: string; stage_id: string }) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { pipelines, stages } = useResources()

  if (pipelines.length === 0) {
    return (
      <>
        <FieldBlock label={t("pipelines.pipelineIdLabel")}>
          <Input
            value={pipelineId}
            onChange={(e) =>
              onChange({ pipeline_id: e.target.value, stage_id: stageId })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <FieldBlock label={t("pipelines.stageIdLabel")}>
          <Input
            value={stageId}
            onChange={(e) =>
              onChange({ pipeline_id: pipelineId, stage_id: e.target.value })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      </>
    )
  }

  const selectedPipeline = pipelines.find((p) => p.id === pipelineId)
  const stageOptions = stages.filter((s) => s.pipeline_id === pipelineId)
  const selectedStage = stageOptions.find((s) => s.id === stageId)

  return (
    <>
      <FieldBlock label={t("pipelines.pipelineLabel")}>
        <select
          value={pipelineId}
          onChange={(e) => {
            const nextPipelineId = e.target.value
            const firstStage = stages.find(
              (s) => s.pipeline_id === nextPipelineId
            )
            onChange({
              pipeline_id: nextPipelineId,
              stage_id: firstStage?.id ?? "",
            })
          }}
          className={SELECT_CLASS}
        >
          <option value="">{t("pipelines.selectPipeline")}</option>
          {pipelines.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {pipelineId && !selectedPipeline && (
            <option value={pipelineId}>{t("pipelines.unknownPipeline", { id: pipelineId })}</option>
          )}
        </select>
      </FieldBlock>
      <FieldBlock label={t("pipelines.stageLabel")}>
        <select
          value={stageId}
          onChange={(e) =>
            onChange({ pipeline_id: pipelineId, stage_id: e.target.value })
          }
          className={SELECT_CLASS}
          disabled={!pipelineId || stageOptions.length === 0}
        >
          <option value="">
            {pipelineId ? t("pipelines.selectStage") : t("pipelines.selectPipelineFirst")}
          </option>
          {stageOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          {stageId && pipelineId && !selectedStage && (
            <option value={stageId}>{t("pipelines.unknownStage", { id: stageId })}</option>
          )}
        </select>
      </FieldBlock>
    </>
  )
}

/** Template dropdown showing approved templates by name + language,
 *  storing both template_name and language. Falls back to manual name +
 *  language inputs when no approved templates are synced yet. */
function SendTemplateFields({
  templateName,
  language,
  onChange,
  t,
}: {
  templateName: string
  language: string
  onChange: (patch: { template_name: string; language: string }) => void
  t: ReturnType<typeof useTranslations>
}) {
  const { templates } = useResources()

  if (templates.length === 0) {
    return (
      <>
        <FieldBlock label={t("templates.templateNameLabel")}>
          <Input
            value={templateName}
            onChange={(e) =>
              onChange({ template_name: e.target.value, language })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
        <FieldBlock label={t("templates.languageLabel")}>
          <Input
            value={language}
            onChange={(e) =>
              onChange({ template_name: templateName, language: e.target.value })
            }
            className="bg-muted text-foreground"
          />
        </FieldBlock>
      </>
    )
  }

  // Encode name + language in the option value so two templates that
  // share a name across languages stay distinct.
  const toValue = (name: string, lang: string) => `${name}::${lang}`
  const current = templateName ? toValue(templateName, language) : ""
  const hasMatch = templates.some(
    (t) => toValue(t.name, t.language ?? "en_US") === current,
  )

  return (
    <FieldBlock label={t("templates.templateLabel")}>
      <select
        value={current}
        onChange={(e) => {
          const [name, lang] = e.target.value.split("::")
          onChange({ template_name: name ?? "", language: lang ?? "" })
        }}
        className={SELECT_CLASS}
      >
        <option value="">{t("templates.select")}</option>
        {templates.map((tmpl) => {
          const lang = tmpl.language ?? "en_US"
          return (
            <option key={tmpl.id} value={toValue(tmpl.name, lang)}>
              {tmpl.name} ({lang})
            </option>
          )
        })}
        {current && !hasMatch && (
          <option value={current}>
            {t("templates.unknown", { name: templateName, lang: language || t("templates.unknownLang") })}
          </option>
        )}
      </select>
    </FieldBlock>
  )
}

// ------------------------------------------------------------
// Main builder component
// ------------------------------------------------------------

export function AutomationBuilder({ initial }: { initial: BuilderInitial }) {
  const router = useRouter()
  const t = useTranslations("Automations.builder")
  const isEditing = !!initial.id
  const [state, setState] = useState<BuilderInitial>(initial)
  const [saving, setSaving] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  function patchTop<K extends keyof BuilderInitial>(key: K, value: BuilderInitial[K]) {
    setState((s) => ({ ...s, [key]: value }))
  }

  // --- Step tree mutations (immutable) ---

  function updateStep(path: StepPath, updater: (s: BuilderStep) => BuilderStep) {
    setState((s) => ({ ...s, steps: mapAtPath(s.steps, path, updater) }))
  }

  function addStepAt(parent: ParentScope, index: number, type: AutomationStepType) {
    const node: BuilderStep = {
      cid: cid(),
      step_type: type,
      step_config: blankConfig(type),
      branches: type === "condition" ? { yes: [], no: [] } : undefined,
    }
    setState((s) => ({ ...s, steps: insertAt(s.steps, parent, index, node) }))
    setExpandedId(node.cid)
  }

  function deleteStepAt(path: StepPath) {
    setState((s) => ({ ...s, steps: removeAt(s.steps, path) }))
  }

  function moveStepAt(path: StepPath, direction: -1 | 1) {
    setState((s) => ({ ...s, steps: moveAt(s.steps, path, direction) }))
  }

  async function save() {
    setSaving(true)
    try {
      const payload = {
        name: state.name || t("untitled"),
        description: state.description || null,
        trigger_type: state.trigger_type,
        trigger_config: state.trigger_config,
        is_active: state.is_active,
        steps: toApiSteps(state.steps),
      }

      const res = isEditing
        ? await fetch(`/api/automations/${initial.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch(`/api/automations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })

      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // If the server blocked activation with validation issues,
        // surface the first concrete problem so the user can fix it
        // without opening DevTools for the full array.
        const firstIssue: { path?: string; message?: string } | undefined =
          body?.issues?.[0]
        if (firstIssue?.message) {
          toast.error(firstIssue.message, {
            description: firstIssue.path ? `at ${firstIssue.path}` : undefined,
          })
        } else {
          toast.error(body?.error ?? t("toasts.saveFailed"))
        }
        return
      }
      toast.success(isEditing ? t("toasts.saved") : t("toasts.created"))
      if (!isEditing && body?.automation?.id) {
        router.replace(`/automations/${body.automation.id}/edit`)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      {/* Top bar. At sub-sm widths the "Active" label is hidden and the
          switch moves to the right of the save button, so the name input
          gets maximum width. */}
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-card/80 px-3 py-3 sm:gap-3 sm:px-4">
        <button
          type="button"
          onClick={() => router.push("/automations")}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={t("backToAutomations")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <input
          value={state.name}
          onChange={(e) => patchTop("name", e.target.value)}
          placeholder={t("untitled")}
          className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:bg-muted focus:outline-none sm:text-base"
        />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="hidden sm:inline">{t("active")}</span>
          <Switch
            checked={state.is_active}
            onCheckedChange={(v) => patchTop("is_active", !!v)}
            aria-label={t("activeAria")}
          />
        </div>
        <Button
          onClick={save}
          disabled={saving}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {isEditing ? t("save") : t("saveDraft")}
        </Button>
      </header>

      {/* Canvas */}
      <div className="relative flex-1 overflow-y-auto">
        <div className="absolute inset-0 bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] [background-size:20px_20px] pointer-events-none" />
        <div className="relative mx-auto flex max-w-2xl flex-col items-center gap-0 px-4 py-10">
          <ResourcesProvider>
            <TriggerCard
              type={state.trigger_type}
              config={state.trigger_config}
              onTypeChange={(tVal) => patchTop("trigger_type", tVal)}
              onConfigChange={(c) => patchTop("trigger_config", c)}
              t={t}
              automationId={initial.id}
            />
            <StepList
              steps={state.steps}
              basePath={[]}
              scope={{ kind: "root" }}
              expandedId={expandedId}
              setExpandedId={setExpandedId}
              updateStep={updateStep}
              addStepAt={addStepAt}
              deleteStepAt={deleteStepAt}
              moveStepAt={moveStepAt}
            />
          </ResourcesProvider>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------
// Trigger card
// ------------------------------------------------------------

function TriggerCard({
  type,
  config,
  onTypeChange,
  onConfigChange,
  t,
  automationId,
}: {
  type: AutomationTriggerType
  config: Record<string, unknown>
  onTypeChange: (t: AutomationTriggerType) => void
  onConfigChange: (c: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
  automationId?: string
}) {
  const [open, setOpen] = useState(false)
  const labels = useLabels()
  return (
    // Card width: full on mobile, fixed 320px on sm+. The canvas wrapper
    // (max-w-2xl + px-4) keeps this tidy on tablet/desktop.
    <div className="z-10 w-full max-w-[320px] sm:w-80">
      <div className="rounded-lg border border-border border-l-4 border-l-blue-500 bg-card shadow-lg">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-500/10 text-blue-400">
            <Zap className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-wide text-blue-300">{t("trigger")}</div>
            <div className="truncate text-sm font-medium text-foreground">
              {labels.trigger(type)}
            </div>
          </div>
          <ChevronDown
            className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </button>
        {open && (
          <div className="space-y-3 border-t border-border px-4 py-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t("triggerType")}
              </label>
              <select
                value={type}
                onChange={(e) => onTypeChange(e.target.value as AutomationTriggerType)}
                className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"
              >
                {TRIGGER_GROUPS.map((g) => (
                  <optgroup key={g.id} label={labels.tb(`triggerGroups.${g.id}`)}>
                    {g.triggers.map((tr) => (
                      <option key={tr} value={tr}>
                        {labels.trigger(tr)}
                      </option>
                    ))}
                  </optgroup>
                ))}
                {/* Keep any saved trigger the list doesn't know. */}
                {!TRIGGER_OPTIONS.some((o) => o.value === type) && !NEW_TRIGGERS.has(type) && (
                  <option value={type}>{type}</option>
                )}
              </select>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {labels.hint(type)}
              </p>
            </div>
            {type === "keyword_match" && (
              <KeywordMatchConfig
                config={config as unknown as KeywordMatchTriggerConfig}
                onChange={onConfigChange}
                t={t}
              />
            )}
            {type === "interactive_reply" && (
              <InteractiveReplyConfig config={config} onChange={onConfigChange} t={t} />
            )}
            {type === "tag_added" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Tag
                </label>
                <TagSelect
                  value={(config.tag_id as string) ?? ""}
                  onChange={(v) => onConfigChange({ ...config, tag_id: v })}
                  t={t}
                />
              </div>
            )}
            {type === "time_based" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  {t("schedule")}
                </label>
                <Input
                  placeholder={t("schedulePlaceholder")}
                  value={(config.schedule as string) ?? ""}
                  onChange={(e) =>
                    onConfigChange({ ...config, schedule: e.target.value })
                  }
                  className="bg-muted text-foreground"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t("scheduleHint")}
                </p>
                <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                  {labels.tb("timeBasedNotRunning")}
                </p>
              </div>
            )}
            <BotStudioTriggerConfig
              type={type}
              config={config}
              onChange={onConfigChange}
              automationId={automationId}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function KeywordMatchConfig({
  config,
  onChange,
  t,
}: {
  config: KeywordMatchTriggerConfig
  onChange: (c: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  const keywords = config?.keywords ?? []
  // Keep a local draft string so the comma and trailing space aren't
  // stripped on every keystroke (which made multi-word, comma-separated
  // entry like "SEO, search engine optimization" impossible to type).
  // We only parse into the keywords array on blur, then re-display the
  // cleaned, rejoined form. Seeded once on mount; this component remounts
  // when the trigger type changes, so the seed stays in sync.
  const [draft, setDraft] = useState(keywords.join(", "))

  // Persist the default the <select> displays. The dropdown falls back to
  // "contains" for display, but leaving it untouched would otherwise omit
  // match_type from the saved config — and activation validation then
  // rejected it (trigger.match_type). Seed once on mount; the component
  // remounts when the trigger type changes, matching the keywords draft.
  useEffect(() => {
    if (config?.match_type == null) {
      onChange({ ...config, match_type: "contains" })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function commit() {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    setDraft(parsed.join(", "))
    onChange({ ...config, keywords: parsed })
  }

  return (
    <div className="space-y-2">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          {t("keywords")}
        </label>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            }
          }}
          placeholder={t("keywordsHint")}
          className="bg-muted text-foreground"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          {t("config.matchType")}
        </label>
        <select
          value={config?.match_type ?? "contains"}
          onChange={(e) =>
            onChange({
              ...config,
              match_type: e.target.value as "exact" | "contains" | "word",
            })
          }
          className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:outline-none"
        >
          <option value="contains">{t("config.matchContains")}</option>
          <option value="word">{t("config.matchWord")}</option>
          <option value="exact">{t("config.matchExact")}</option>
        </select>
        {/* Only worth explaining for `word` — "contains" and "exact" read
            for themselves, and this is the one that changes which messages
            fire an automation in a way that isn't obvious. */}
        {config?.match_type === "word" && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("config.matchWordHint")}
          </p>
        )}
      </div>
    </div>
  )
}

function InteractiveReplyConfig({
  config,
  onChange,
  t,
}: {
  config: Record<string, unknown>
  onChange: (c: Record<string, unknown>) => void
  t: ReturnType<typeof useTranslations>
}) {
  const ids = (config?.reply_ids as string[] | undefined) ?? []
  // Same local-draft-then-commit pattern as KeywordMatchConfig so
  // commas + spaces survive keystrokes.
  const [draft, setDraft] = useState(ids.join(", "))

  function commit() {
    const parsed = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    setDraft(parsed.join(", "))
    onChange({ ...config, reply_ids: parsed })
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        {t("replyIds")}
      </label>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          }
        }}
        placeholder={t("replyIdsHint")}
        className="bg-muted font-mono text-foreground"
      />
      <p className="mt-1 text-[11px] text-muted-foreground">{t("replyIdsHelp")}</p>
    </div>
  )
}

// ------------------------------------------------------------
// Step list + card + connectors
// ------------------------------------------------------------

interface StepListProps {
  steps: BuilderStep[]
  /**
   * Path of the step that owns this list — `[]` for the root canvas,
   * the condition's own path for a branch column. Combined with
   * `scope` by `childPath` to address each child.
   */
  basePath: StepPath
  /** Which bucket this list reads and writes. */
  scope: ParentScope
  expandedId: string | null
  setExpandedId: (id: string | null) => void
  updateStep: (path: StepPath, updater: (s: BuilderStep) => BuilderStep) => void
  addStepAt: (parent: ParentScope, index: number, type: AutomationStepType) => void
  deleteStepAt: (path: StepPath) => void
  moveStepAt: (path: StepPath, direction: -1 | 1) => void
}

function StepList(props: StepListProps) {
  const { steps, basePath, scope, ...rest } = props

  return (
    <div className="flex w-full flex-col items-center">
      <AddButton onPick={(t) => props.addStepAt(scope, 0, t)} />
      {steps.map((step, idx) => (
        <StepRenderer
          key={step.cid}
          step={step}
          index={idx}
          total={steps.length}
          basePath={basePath}
          scope={scope}
          {...rest}
        />
      ))}
    </div>
  )
}

function StepRenderer({
  step,
  index,
  total,
  scope,
  basePath,
  ...props
}: {
  step: BuilderStep
  index: number
  total: number
  scope: ParentScope
  basePath: StepPath
} & Omit<StepListProps, "steps" | "basePath" | "scope">) {
  const t = useTranslations("Automations.builder")
  const path = childPath(basePath, scope, index)
  const meta = STEP_META[step.step_type]
  const Icon = meta.icon
  const expanded = props.expandedId === step.cid
  const isCondition = step.step_type === "condition"
  const nested = basePath.length > 0
  // Card widths on mobile fill the full canvas column (max-w-2xl px-4
  // still keeps them reasonable). On sm+ fixed widths come back so the
  // flow visual stays recognisable — but only at the top level: a
  // branch column is a fraction of its condition's width, so a 320px
  // card inside one overflowed its own column and dragged the editor's
  // controls out of reach (issue #474). Nested cards fill the column
  // they were given instead.
  //
  // A condition is wider than a plain step because it has to hold two
  // branch columns side by side; 600px (the canvas is max-w-2xl, i.e.
  // 640px of content) leaves each branch ~294px — near enough to the
  // 320px a step gets at the top level for the same editors to fit.
  const width = nested
    ? "w-full"
    : isCondition
      ? "w-full max-w-[600px] sm:w-[600px]"
      : "w-full max-w-[320px] sm:w-80"

  return (
    <>
      <div className={cn("z-10 flex min-w-0 flex-col", width)}>
        <div
          className={cn(
            "rounded-lg border border-border border-l-4 bg-card shadow-lg",
            meta.border,
          )}
        >
          <button
            type="button"
            onClick={() => props.setExpandedId(expanded ? null : step.cid)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left"
          >
            <GripVertical className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {isCondition ? t("kindCondition") : step.step_type === "wait" ? t("kindWait") : t("kindAction")}
              </div>
              <div className="truncate text-sm font-medium text-foreground">{t(`steps.${meta.label}`)}</div>
              <div className="truncate text-[11px] text-muted-foreground">{previewFor(step)}</div>
            </div>
            <ChevronDown
              className={cn("h-4 w-4 text-muted-foreground transition-transform", expanded && "rotate-180")}
            />
          </button>
          {expanded && (
            <div className="border-t border-border px-4 py-3">
              <StepEditor
                step={step}
                onChange={(next) => props.updateStep(path, () => next)}
              />
              <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={index === 0}
                    aria-label={t("moveUp")}
                    onClick={() => props.moveStepAt(path, -1)}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={index === total - 1}
                    aria-label={t("moveDown")}
                    onClick={() => props.moveStepAt(path, 1)}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => props.deleteStepAt(path)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("delete")}
                </Button>
              </div>
            </div>
          )}
        </div>

        {isCondition && (
          <ConditionBranches step={step} path={path} {...props} />
        )}
      </div>

      {/* A condition branches into Yes/No (rendered above by
          ConditionBranches), so it has no linear "continue" path — adding
          the trailing connector here would produce a spurious third output. */}
      {!isCondition && (
        <AddButton onPick={(t) => props.addStepAt(scope, index + 1, t)} />
      )}
    </>
  )
}

function ConditionBranches({
  step,
  path,
  ...props
}: {
  step: BuilderStep
  /** The condition's OWN path. Children hang off it, one marker each. */
  path: StepPath
} & Omit<StepListProps, "steps" | "basePath" | "scope">) {
  const t = useTranslations("Automations.builder")
  const yes = step.branches?.yes ?? []
  const no = step.branches?.no ?? []
  return (
    // Stack Yes/No vertically until THIS CARD is wide enough for two
    // columns. A viewport breakpoint can't tell: a condition nested in
    // a branch is a fraction of the screen, and `sm:grid-cols-2` split
    // it anyway, leaving two columns too narrow to render a step in.
    <div className="@container mt-3 w-full">
      <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
        <BranchColumn label={t("branches.yes")} color="text-primary">
          <StepList
            {...props}
            steps={yes}
            basePath={path}
            scope={{ kind: "branch", parentCid: step.cid, branch: "yes" }}
          />
        </BranchColumn>
        <BranchColumn label={t("branches.no")} color="text-rose-400">
          <StepList
            {...props}
            steps={no}
            basePath={path}
            scope={{ kind: "branch", parentCid: step.cid, branch: "no" }}
          />
        </BranchColumn>
      </div>
    </div>
  )
}

function BranchColumn({
  label,
  color,
  children,
}: {
  label: string
  color: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col items-center">
      <div className={cn("mb-2 text-[11px] font-semibold uppercase", color)}>{label}</div>
      {children}
    </div>
  )
}

function AddButton({ onPick }: { onPick: (t: AutomationStepType) => void }) {
  const t = useTranslations("Automations.builder")
  const labels = useLabels()
  return (
    <div className="relative flex flex-col items-center">
      <div className="h-4 w-[2px] bg-border" aria-hidden />
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-dashed border-border bg-background text-muted-foreground transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary data-[popup-open]:border-primary data-[popup-open]:bg-primary/20 data-[popup-open]:text-primary"
          aria-label={t("addStep")}
        >
          <Plus className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-80 min-w-56 overflow-y-auto border-border bg-popover"
        >
          {STEP_GROUPS.map((g) => (
            <DropdownMenuGroup key={g.id}>
              <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {labels.tb(`stepGroups.${g.id}`)}
              </DropdownMenuLabel>
              {g.steps.map((tp) => {
                const Icon = STEP_META[tp].icon
                return (
                  <DropdownMenuItem key={tp} onClick={() => onPick(tp)}>
                    <Icon className="h-4 w-4" />
                    {labels.step(tp)}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="h-4 w-[2px] bg-border" aria-hidden />
    </div>
  )
}

// ------------------------------------------------------------
// Per-step config editor
// ------------------------------------------------------------

function StepEditor({
  step,
  onChange,
}: {
  step: BuilderStep
  onChange: (s: BuilderStep) => void
}) {
  const t = useTranslations("Automations.builder")
  const tb = useTranslations("BotStudio.automation")
  const cfg = step.step_config
  const set = (patch: Record<string, unknown>) =>
    onChange({ ...step, step_config: { ...cfg, ...patch } })

  switch (step.step_type) {
    case "send_message":
      return (
        <FieldBlock label={t("config.messageText")}>
          <Textarea
            value={(cfg.text as string) ?? ""}
            onChange={(e) => set({ text: e.target.value })}
            placeholder={t("config.placeholderMessageText")}
            className="min-h-24 bg-muted text-foreground"
          />
          <div className="mt-1 flex justify-end">
            <VariablePicker showMessage onInsert={(tok) => set({ text: `${(cfg.text as string) ?? ""}${tok}` })} />
          </div>
        </FieldBlock>
      )
    case "send_buttons":
    case "send_list":
      // The whole step_config IS the interactive payload; the shared
      // builder edits it in place (and enforces Meta's limits + preview).
      return (
        <InteractiveBuilder
          value={asInteractive(cfg)}
          onChange={(payload) =>
            onChange({ ...step, step_config: toStepConfig(payload) })
          }
        />
      )
    case "send_template":
      return (
        <SendTemplateFields
          templateName={(cfg.template_name as string) ?? ""}
          language={(cfg.language as string) ?? ""}
          onChange={(patch) => set(patch)}
          t={t}
        />
      )
    case "add_tag":
    case "remove_tag":
      return (
        <FieldBlock label={t("config.tagLabel")}>
          <TagSelect
            value={(cfg.tag_id as string) ?? ""}
            onChange={(v) => set({ tag_id: v })}
            t={t}
          />
        </FieldBlock>
      )
    case "assign_conversation":
      return (
        <>
          <FieldBlock label={t("config.modeLabel")}>
            <select
              value={(cfg.mode as string) ?? "round_robin"}
              onChange={(e) => set({ mode: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="round_robin">{t("config.modes.round_robin")}</option>
              <option value="random">{tb("assign.random")}</option>
              <option value="specific">{t("config.modes.specific")}</option>
            </select>
          </FieldBlock>
          {cfg.mode === "specific" && (
            <FieldBlock label={t("config.agentLabel")}>
              <AgentSelect
                value={(cfg.agent_id as string) ?? ""}
                onChange={(v) => set({ agent_id: v })}
                t={t}
              />
            </FieldBlock>
          )}
          {cfg.mode !== "specific" && (
            <AgentPool
              value={(cfg.pool as string[] | undefined) ?? []}
              onChange={(pool) => set({ pool })}
            />
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={cfg.reassign !== false}
              onCheckedChange={(v) => set({ reassign: !!v })}
            />
            {tb("assign.reassign")}
          </label>
        </>
      )
    case "update_contact_field":
      return (
        <>
          <FieldBlock label={t("config.fieldLabel")}>
            <ContactFieldSelect
              value={(cfg.field as string) ?? "name"}
              onChange={(v) => set({ field: v })}
              t={t}
            />
          </FieldBlock>
          <FieldBlock label={t("config.valueLabel")}>
            <Input
              value={(cfg.value as string) ?? ""}
              onChange={(e) => set({ value: e.target.value })}
              placeholder={t.raw("config.placeholderValue")}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "create_deal":
      return (
        <>
          <DealPipelineFields
            pipelineId={(cfg.pipeline_id as string) ?? ""}
            stageId={(cfg.stage_id as string) ?? ""}
            onChange={(patch) => set(patch)}
            t={t}
          />
          <FieldBlock label={t("config.titleLabel")}>
            <Input
              value={(cfg.title as string) ?? ""}
              onChange={(e) => set({ title: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.valueLabel")}>
            <Input
              type="number"
              value={(cfg.value as number) ?? 0}
              onChange={(e) => set({ value: Number(e.target.value) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "wait":
      return (
        <div className="grid grid-cols-2 gap-2">
          <FieldBlock label={t("config.amountLabel")}>
            <Input
              type="number"
              min={1}
              value={(cfg.amount as number) ?? 1}
              onChange={(e) => set({ amount: Math.max(1, Number(e.target.value)) })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.unitLabel")}>
            <select
              value={(cfg.unit as string) ?? "hours"}
              onChange={(e) => set({ unit: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="minutes">{t("config.units.minutes")}</option>
              <option value="hours">{t("config.units.hours")}</option>
              <option value="days">{t("config.units.days")}</option>
            </select>
          </FieldBlock>
        </div>
      )
    case "condition":
      return (
        <>
          <FieldBlock label={t("config.subjectLabel")}>
            <select
              value={(cfg.subject as string) ?? "tag_presence"}
              onChange={(e) => set({ subject: e.target.value })}
              className="w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground"
            >
              <option value="tag_presence">{t("config.subjects.tag_presence")}</option>
              <option value="contact_field">{t("config.subjects.contact_field")}</option>
              <option value="message_content">{t("config.subjects.message_content")}</option>
              <option value="time_of_day">{t("config.subjects.time_of_day")}</option>
              <option value="working_hours">{tb("conditionWorkingHours")}</option>
            </select>
          </FieldBlock>
          {cfg.subject === "working_hours" ? (
            <p className="text-xs text-muted-foreground">{tb("conditionWorkingHoursHint")}</p>
          ) : (
          <FieldBlock label={t("config.operandLabel")}>
            <Input
              placeholder={
                cfg.subject === "time_of_day"
                  ? t("config.placeholderTime")
                  : cfg.subject === "contact_field"
                  ? t("config.placeholderContact")
                  : cfg.subject === "tag_presence"
                  ? t("config.placeholderTag")
                  : ""
              }
              value={(cfg.operand as string) ?? ""}
              onChange={(e) => set({ operand: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          )}
          {(cfg.subject === "contact_field" || cfg.subject === "message_content") && (
            <FieldBlock label={t("config.valueLabel")}>
              <Input
                value={(cfg.value as string) ?? ""}
                onChange={(e) => set({ value: e.target.value })}
                className="bg-muted text-foreground"
              />
            </FieldBlock>
          )}
        </>
      )
    case "send_webhook":
      return (
        <>
          <FieldBlock label={t("config.urlLabel")}>
            <Input
              value={(cfg.url as string) ?? ""}
              onChange={(e) => set({ url: e.target.value })}
              className="bg-muted text-foreground"
            />
          </FieldBlock>
          <FieldBlock label={t("config.bodyTemplateLabel")}>
            <Textarea
              value={(cfg.body_template as string) ?? ""}
              onChange={(e) => set({ body_template: e.target.value })}
              className="min-h-20 bg-muted font-mono text-xs text-foreground"
            />
          </FieldBlock>
        </>
      )
    case "close_conversation":
      return (
        <p className="text-xs text-muted-foreground">
          {t("config.closeConversationHint", { defaultValue: "Sets the conversation status to \"closed\". No configuration needed." })}
        </p>
      )
    case "send_location":
    case "opt_out":
    case "wait_until":
    case "format_date":
    case "format_phone":
    case "start_flow":
      return <BotStudioStepEditor type={step.step_type} cfg={cfg} set={set} />
    default:
      return null
  }
}

function FieldBlock({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="mb-2 last:mb-0">
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

function previewFor(step: BuilderStep): string {
  switch (step.step_type) {
    case "send_message":
      return (step.step_config.text as string) || "no text yet"
    case "send_buttons":
    case "send_list":
      return interactivePayloadPreviewText(asInteractive(step.step_config)) || "no body yet"
    case "send_template":
      return (step.step_config.template_name as string) || "pick a template"
    case "wait":
      return `${step.step_config.amount ?? "?"} ${step.step_config.unit ?? ""}`
    case "condition":
      return `when ${step.step_config.subject ?? "?"}`
    case "send_webhook":
      return (step.step_config.url as string) || "no url"
    case "send_location":
      return [step.step_config.name, step.step_config.latitude, step.step_config.longitude].filter(Boolean).join(" · ")
    case "wait_until":
      return (step.step_config.at as string) || ""
    case "format_date":
    case "format_phone":
      return step.step_config.output_var ? `→ vars.${step.step_config.output_var}` : ""
    default:
      return ""
  }
}

// ------------------------------------------------------------
// Serialize builder tree → API payload (flattened shape)
// ------------------------------------------------------------

interface ApiStep {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: ApiStep[]; no?: ApiStep[] }
}

export function toApiSteps(steps: BuilderStep[]): ApiStep[] {
  return steps.map((s) => ({
    step_type: s.step_type,
    step_config: s.step_config,
    branches: s.branches
      ? { yes: toApiSteps(s.branches.yes), no: toApiSteps(s.branches.no) }
      : undefined,
  }))
}

/**
 * Convert server-returned step tree (from loadStepsTree) into the
 * builder-local shape with client ids.
 */
export interface ServerStepNode {
  id: string
  step_type: string
  step_config: Record<string, unknown>
  branches: { yes: ServerStepNode[]; no: ServerStepNode[] }
}

export function fromServerSteps(nodes: ServerStepNode[]): BuilderStep[] {
  return nodes.map((n) => ({
    cid: cid(),
    step_type: n.step_type as AutomationStepType,
    step_config: n.step_config ?? {},
    branches:
      n.step_type === "condition"
        ? {
            yes: fromServerSteps(n.branches?.yes ?? []),
            no: fromServerSteps(n.branches?.no ?? []),
          }
        : undefined,
  }))
}


// ------------------------------------------------------------
// Bot Studio additions (triggers, steps, pickers)
// ------------------------------------------------------------

const ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"]

function AgentPool({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const tb = useTranslations("BotStudio.automation")
  const { members } = useResources()
  const assignable = members.filter((m) => m.role !== "viewer")
  if (assignable.length === 0) return null
  return (
    <FieldBlock label={tb("assign.pool")}>
      <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border border-border p-2">
        {assignable.map((m) => (
          <label key={m.user_id} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={value.includes(m.user_id)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, m.user_id] : value.filter((id) => id !== m.user_id))
              }
            />
            {m.full_name || m.email || m.user_id}
          </label>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{tb("assign.poolHint")}</p>
    </FieldBlock>
  )
}

function useActiveFlows() {
  const [flows, setFlows] = useState<{ id: string; name: string; status: string }[]>([])
  useEffect(() => {
    void createClient()
      .from("flows")
      .select("id, name, status")
      .neq("status", "archived")
      .order("name")
      .then(({ data }) => setFlows((data ?? []) as { id: string; name: string; status: string }[]))
  }, [])
  return flows
}

function BotStudioStepEditor({
  type,
  cfg,
  set,
}: {
  type: AutomationStepType
  cfg: Record<string, unknown>
  set: (patch: Record<string, unknown>) => void
}) {
  const tb = useTranslations("BotStudio.automation")
  const flows = useActiveFlows()
  const text = (k: string, label: string, placeholder?: string, withVars = true) => (
    <FieldBlock label={label}>
      <div className="flex gap-1">
        <Input
          value={(cfg[k] as string) ?? ""}
          onChange={(e) => set({ [k]: e.target.value })}
          placeholder={placeholder}
          className="bg-muted text-foreground"
        />
        {withVars && <VariablePicker showMessage onInsert={(tok) => set({ [k]: `${(cfg[k] as string) ?? ""}${tok}` })} />}
      </div>
    </FieldBlock>
  )
  const outVar = (
    <FieldBlock label={tb("format.outputVar")}>
      <Input
        value={(cfg.output_var as string) ?? ""}
        onChange={(e) => set({ output_var: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })}
        className="bg-muted font-mono text-xs text-foreground"
      />
      <p className="mt-1 text-[11px] text-muted-foreground">
        {tb("format.outputHint", { token: `{{vars.${(cfg.output_var as string) || "x"}}}` })}
      </p>
    </FieldBlock>
  )

  switch (type) {
    case "send_location":
      return (
        <>
          <div className="grid grid-cols-2 gap-2">
            {text("latitude", tb("location.latitude"), "18.5204", false)}
            {text("longitude", tb("location.longitude"), "73.8567", false)}
          </div>
          {text("name", tb("location.name"))}
          {text("address", tb("location.address"))}
          <p className="text-[11px] text-muted-foreground">{tb("windowNote")}</p>
        </>
      )
    case "opt_out":
      return <p className="text-xs text-muted-foreground">{tb("optOutHint")}</p>
    case "wait_until":
      return (
        <>
          {text("at", tb("waitUntil.at"), "2026-11-01T10:00")}
          <div className="grid grid-cols-2 gap-2">
            <FieldBlock label={tb("waitUntil.timezone")}>
              <select value={(cfg.timezone as string) ?? "Asia/Kolkata"} onChange={(e) => set({ timezone: e.target.value })} className={SELECT_CLASS}>
                {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </FieldBlock>
            <FieldBlock label={tb("waitUntil.offset")}>
              <Input
                type="number"
                min={0}
                value={(cfg.offset_minutes as number) ?? 0}
                onChange={(e) => set({ offset_minutes: Math.max(0, Number(e.target.value) || 0) })}
                className="bg-muted text-foreground"
              />
            </FieldBlock>
          </div>
          <FieldBlock label={tb("waitUntil.ifPast")}>
            <select value={(cfg.if_past as string) ?? "run_now"} onChange={(e) => set({ if_past: e.target.value })} className={SELECT_CLASS}>
              <option value="run_now">{tb("waitUntil.runNow")}</option>
              <option value="skip">{tb("waitUntil.skip")}</option>
            </select>
          </FieldBlock>
          <p className="text-[11px] text-muted-foreground">{tb("waitUntil.hint")}</p>
        </>
      )
    case "format_date":
      return (
        <>
          {text("input", tb("format.input"), "{{vars.visit_date}}")}
          <div className="grid grid-cols-2 gap-2">
            <FieldBlock label={tb("format.inputFormat")}>
              <select value={(cfg.input_format as string) ?? "auto"} onChange={(e) => set({ input_format: e.target.value })} className={SELECT_CLASS}>
                {["auto", "iso", "dmy", "mdy", "ymd", "epoch_ms", "epoch_s"].map((f) => <option key={f} value={f}>{tb(`format.inputFormats.${f}`)}</option>)}
              </select>
            </FieldBlock>
            <FieldBlock label={tb("format.timezone")}>
              <select value={(cfg.output_timezone as string) ?? "Asia/Kolkata"} onChange={(e) => set({ output_timezone: e.target.value, input_timezone: (cfg.input_timezone as string) || e.target.value })} className={SELECT_CLASS}>
                {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </FieldBlock>
          </div>
          {text("output_format", tb("format.outputFormat"), "DD MMM YYYY, hh:mm A", false)}
          {outVar}
        </>
      )
    case "format_phone":
      return (
        <>
          {text("input", tb("format.input"), "{{contact.phone}}")}
          <div className="grid grid-cols-2 gap-2">
            {text("default_country_code", tb("format.country"), "91", false)}
            <FieldBlock label={tb("format.phoneOutput")}>
              <select value={(cfg.output as string) ?? "e164"} onChange={(e) => set({ output: e.target.value })} className={SELECT_CLASS}>
                <option value="e164">+919876543210</option>
                <option value="digits">919876543210</option>
                <option value="national">9876543210</option>
              </select>
            </FieldBlock>
          </div>
          {outVar}
        </>
      )
    case "start_flow":
      return (
        <>
          <FieldBlock label={tb("startFlow.flow")}>
            <select value={(cfg.flow_id as string) ?? ""} onChange={(e) => set({ flow_id: e.target.value })} className={SELECT_CLASS}>
              <option value="">{tb("startFlow.pick")}</option>
              {flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}{f.status !== "active" ? ` (${tb("startFlow.notActive")})` : ""}
                </option>
              ))}
            </select>
          </FieldBlock>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={cfg.replace_active === true} onCheckedChange={(v) => set({ replace_active: !!v })} />
            {tb("startFlow.replace")}
          </label>
          <p className="text-[11px] text-muted-foreground">{tb("startFlow.hint")}</p>
        </>
      )
    default:
      return null
  }
}

function BotStudioTriggerConfig({
  type,
  config,
  onChange,
  automationId,
  hookApi,
}: {
  type: AutomationTriggerType
  config: Record<string, unknown>
  onChange: (c: Record<string, unknown>) => void
  automationId?: string
  hookApi?: string
}) {
  const t = useTranslations("Automations.builder")
  const tb = useTranslations("BotStudio.automation")
  const list = (k: string) => ((config[k] as string[] | undefined) ?? []).join(", ")
  const setList = (k: string, v: string) =>
    onChange({ ...config, [k]: v.split(",").map((x) => x.trim()).filter(Boolean) })

  switch (type) {
    case "contact_field_changed":
      return (
        <>
          <FieldBlock label={tb("triggerConfig.field")}>
            <select
              value={(config.field as string) ?? ""}
              onChange={(e) => onChange({ ...config, field: e.target.value || undefined })}
              className={SELECT_CLASS}
            >
              <option value="">{tb("triggerConfig.anyField")}</option>
              <FieldOptions t={t} />
            </select>
          </FieldBlock>
          <FieldBlock label={tb("triggerConfig.changeMode")}>
            <select
              value={(config.change_mode as string) ?? "any"}
              onChange={(e) => onChange({ ...config, change_mode: e.target.value === "any" ? undefined : e.target.value })}
              className={SELECT_CLASS}
            >
              <option value="first_set">{tb("triggerConfig.changeModes.first_set")}</option>
              <option value="any">{tb("triggerConfig.changeModes.any")}</option>
              <option value="removed">{tb("triggerConfig.changeModes.removed")}</option>
            </select>
          </FieldBlock>
        </>
      )
    case "ctwa_message":
      return (
        <FieldBlock label={tb("triggerConfig.adIds")}>
          <Input defaultValue={list("source_ids")} onBlur={(e) => setList("source_ids", e.target.value)} placeholder={tb("triggerConfig.anyAd")} className="bg-muted text-foreground" />
        </FieldBlock>
      )
    case "template_delivered":
      return (
        <FieldBlock label={tb("triggerConfig.templates")}>
          <Input defaultValue={list("template_names")} onBlur={(e) => setList("template_names", e.target.value)} placeholder={tb("triggerConfig.anyTemplate")} className="bg-muted text-foreground" />
        </FieldBlock>
      )
    case "conversation_assigned":
      return (
        <FieldBlock label={tb("triggerConfig.agent")}>
          <AgentSelect value={(config.agent_id as string) ?? ""} onChange={(v) => onChange({ ...config, agent_id: v || undefined })} t={t} />
          <p className="mt-1 text-[11px] text-muted-foreground">{tb("triggerConfig.anyAgentHint")}</p>
        </FieldBlock>
      )
    case "sla_breached":
      return <p className="text-[11px] text-muted-foreground">{tb("triggerConfig.slaHint")}</p>
    case "incoming_webhook":
      return (
        <WebhookTriggerPanel
          hookApi={hookApi ?? (automationId ? `/api/automations/${automationId}/webhook` : undefined)}
          config={config}
          onChange={onChange}
        />
      )
    default:
      return null
  }
}

function FieldOptions({ t }: { t: ReturnType<typeof useTranslations> }) {
  const { customFields } = useResources()
  return (
    <>
      <option value="name">{t("fields.name")}</option>
      <option value="email">{t("fields.email")}</option>
      <option value="company">{t("fields.company")}</option>
      {customFields.map((f) => (
        <option key={f.id} value={`custom:${f.id}`}>{f.field_name}</option>
      ))}
    </>
  )
}

interface HookState {
  available?: boolean
  configured?: boolean
  url?: string
  capturing?: boolean
  last_sample?: unknown
  last_sample_at?: string | null
  sample_paths?: string[]
}

function WebhookTriggerPanel({
  hookApi,
  config,
  onChange,
}: {
  /** e.g. /api/automations/<id>/webhook or /api/flows/<id>/webhook. */
  hookApi?: string
  config: Record<string, unknown>
  onChange: (c: Record<string, unknown>) => void
}) {
  const tb = useTranslations("BotStudio.automation.webhook")
  const [state, setState] = useState<HookState | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    if (!hookApi) return
    const res = await fetch(hookApi, { cache: "no-store" })
    setState(res.ok ? ((await res.json()) as HookState) : { available: false })
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hookApi])

  async function act(action: "create" | "rotate" | "capture" | "stop_capture") {
    if (!hookApi) return
    setBusy(true)
    const res = await fetch(hookApi, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    })
    setBusy(false)
    if (!res.ok) {
      const b = await res.json().catch(() => ({}))
      toast.error(b?.error ?? tb("failed"))
      return
    }
    if (action === "rotate") toast.success(tb("rotated"))
    await load()
  }

  if (!hookApi) return <p className="text-[11px] text-muted-foreground">{tb("saveFirst")}</p>
  if (state && state.available === false) return <p className="text-[11px] text-amber-600">{tb("needsMigration")}</p>

  const paths = state?.sample_paths ?? []
  const pathSelect = (key: string, label: string) => (
    <FieldBlock label={label}>
      {paths.length ? (
        <select value={(config[key] as string) ?? ""} onChange={(e) => onChange({ ...config, [key]: e.target.value })} className={SELECT_CLASS}>
          <option value="">{tb("pickField")}</option>
          {paths.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      ) : (
        <Input value={(config[key] as string) ?? ""} onChange={(e) => onChange({ ...config, [key]: e.target.value })} placeholder="lead.phone" className="bg-muted font-mono text-xs text-foreground" />
      )}
    </FieldBlock>
  )

  return (
    <div className="space-y-2">
      {!state?.configured ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("create")}>
          {tb("generate")}
        </Button>
      ) : (
        <>
          <div className="flex gap-1">
            <Input readOnly value={state.url ?? ""} className="bg-muted font-mono text-[11px] text-foreground" />
            <Button size="sm" variant="outline" aria-label={tb("copy")} onClick={() => { void navigator.clipboard.writeText(state.url ?? ""); toast.success(tb("copied")) }}>
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant="outline" aria-label={tb("rotate")} title={tb("rotate")} disabled={busy} onClick={() => void act("rotate")}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(state.capturing ? "stop_capture" : "capture")}>
              <Radar className="h-3.5 w-3.5" />
              {state.capturing ? tb("stopCapture") : tb("capture")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void load()}>{tb("refresh")}</Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{state.capturing ? tb("capturing") : tb("captureHint")}</p>
          {state.last_sample != null && (
            <pre className="max-h-32 overflow-auto rounded-md bg-muted p-2 text-[10px]">{JSON.stringify(state.last_sample, null, 2)}</pre>
          )}
        </>
      )}
      {pathSelect("phone_path", tb("phonePath"))}
      {pathSelect("name_path", tb("namePath"))}
      <div className="grid grid-cols-2 gap-2">
        <FieldBlock label={tb("country")}>
          <Input value={(config.default_country_code as string) ?? ""} onChange={(e) => onChange({ ...config, default_country_code: e.target.value.replace(/\D/g, "") })} placeholder="91" className="bg-muted text-foreground" />
        </FieldBlock>
        <label className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={config.create_contact === true} onCheckedChange={(v) => onChange({ ...config, create_contact: !!v })} />
          {tb("createContact")}
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">{tb("payloadHint", { token: "{{trigger.lead.phone}}" })}</p>
    </div>
  )
}

// ------------------------------------------------------------
// Reused by the Flow builder (one Flow, migration 048): the same step
// and trigger editors, without the automation card chrome. Wrap the
// caller once in <AutomationResourcesProvider> (tags, members,
// templates, fields, pipelines) instead of fetching per card.
// ------------------------------------------------------------

export const AutomationResourcesProvider = ResourcesProvider

/** Tags, members, approved templates, fields, pipelines (inside the provider). */
export const useAutomationResources = useResources

export function AutomationStepFields({
  type,
  config,
  onChange,
}: {
  type: AutomationStepType
  config: Record<string, unknown>
  onChange: (c: Record<string, unknown>) => void
}) {
  return (
    <StepEditor
      step={{ cid: "flow", step_type: type, step_config: config }}
      onChange={(s) => onChange(s.step_config)}
    />
  )
}

export function AutomationTriggerFields({
  type,
  config,
  onChange,
  hookApi,
}: {
  type: AutomationTriggerType
  config: Record<string, unknown>
  onChange: (c: Record<string, unknown>) => void
  hookApi?: string
}) {
  const t = useTranslations("Automations.builder")
  const tu = useTranslations("BotStudio.builder")
  return (
    <div className="space-y-3">
      {type === "interactive_reply" && <InteractiveReplyConfig config={config} onChange={onChange} t={t} />}
      {type === "tag_added" && (
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">{tu("tag")}</label>
          <TagSelect value={(config.tag_id as string) ?? ""} onChange={(v) => onChange({ ...config, tag_id: v })} t={t} />
        </div>
      )}
      <BotStudioTriggerConfig type={type} config={config} onChange={onChange} hookApi={hookApi} />
    </div>
  )
}

/** Translated step label, for the Flow builder's action cards. */
export function useStepLabel() {
  const labels = useLabels()
  return labels.step
}
