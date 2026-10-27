import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationStepType,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  InteractiveReplyTriggerConfig,
  TagTriggerConfig,
  SendMessageStepConfig,
  SendButtonsStepConfig,
  SendListStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  AssignConversationStepConfig,
  ContactFieldChangedTriggerConfig,
  CtwaTriggerConfig,
  TemplateDeliveredTriggerConfig,
  ConversationAssignedTriggerConfig,
  SendLocationStepConfig,
  WaitUntilStepConfig,
  FormatDateStepConfig,
  FormatPhoneStepConfig,
  StartFlowStepConfig,
} from '@/types'
import { supabaseAdmin } from './admin-client'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from '@/lib/contacts/tag-chain'
import { engineSendText, engineSendTemplate, engineSendInteractive, engineSendLocation } from './meta-send'
import { assignConversation, loadBusinessHours, loadContactScope, optOutContact } from '@/lib/bot/actions'
import { formatDate, formatPhone } from '@/lib/bot/formatters'
import { planWaitUntil, workingHoursAt } from '@/lib/bot/working-hours'
import { interpolate as interpolateScope, needsContact } from '@/lib/bot/variables'
import { matchesWholeWord } from '@/lib/bot/keyword'
import { ctwaAdMatches } from '@/lib/meta/ctwa-match'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string
  /** Conversation the event belongs to, if any. */
  conversation_id?: string
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string
  /** Button / list-row id the customer tapped, for interactive_reply. */
  interactive_reply_id?: string
  /** contact_field_changed: which field ('name' | … | 'custom:<id>'). */
  field?: string
  /** ctwa_message: the ad / post id the chat came from. */
  source_id?: string
  /** template_delivered: the template that reached the phone. */
  template_name?: string
  /** Trigger payload ({{trigger.*}}): webhook body, event values. */
  trigger?: Record<string, unknown>
  /** Internal: outer scopes to finish after a resumed branch. */
  _continuations?: Continuation[]
}

/** An enclosing scope to continue once a nested branch completes. */
interface Continuation {
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  nextPosition: number
}

/** Event triggers that can be caused by automation steps themselves. */
const LOOP_GUARDED_TRIGGERS = new Set<AutomationTriggerType>([
  'conversation_assigned',
  'conversation_opened',
  'conversation_closed',
  'contact_field_changed',
])
const LOOP_GUARD_MAX_RUNS = 5
const LOOP_GUARD_WINDOW_MS = 10 * 60_000

export interface DispatchInput {
  /** Account-level tenancy key. Drives the lookup of which active
   *  automations to fire — `automations.account_id` is the tenant
   *  isolation after migration 017. Replaces the previous `userId`
   *  field; the per-automation user_id is read off each row when
   *  needed (sender identity for outbound messages, log audit). */
  accountId: string
  triggerType: AutomationTriggerType
  contactId?: string | null
  context?: AutomationContext
  /** Run only this automation (its own inbound webhook URL). */
  automationId?: string
}

/**
 * Fire all active automations matching the given trigger for an
 * account.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
export async function runAutomationsForTrigger(input: DispatchInput): Promise<number> {
  let ran = 0
  try {
    const db = supabaseAdmin()

    // Tenant isolation. `contactId` can be caller-supplied (the manual
    // POST /api/automations/engine entrypoint reads it straight from the
    // request body), and every step below runs through the service-role
    // client, which bypasses RLS. So before any step can touch the
    // contact, verify it actually belongs to this account. A foreign or
    // forged id is refused silently — callers are fire-and-forget, and a
    // distinct error would leak whether a given contact UUID exists.
    if (input.contactId) {
      const { data: owned, error: ownErr } = await db
        .from('contacts')
        .select('id')
        .eq('id', input.contactId)
        .eq('account_id', input.accountId)
        .maybeSingle()
      if (ownErr) {
        console.error('[automations] contact ownership check failed:', ownErr)
        return 0
      }
      if (!owned) {
        console.warn('[automations] contact not in account, refusing dispatch', input.contactId)
        return 0
      }
    }

    const { data: automations, error } = await db
      .from('automations')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('trigger_type', input.triggerType)
      .eq('is_active', true)

    if (error) console.error('[automations] fetch failed:', error)

    for (const automation of (automations ?? []) as Automation[]) {
      if (input.automationId && automation.id !== input.automationId) continue
      if (!triggerMatches(automation, input.context)) continue
      // Loop guard for events that steps can cause themselves (assign →
      // assigned → assign…, field → changed → field…): at most 5 runs of
      // one automation per contact per 10 minutes.
      if (LOOP_GUARDED_TRIGGERS.has(input.triggerType) && input.contactId) {
        const { count } = await db
          .from('automation_logs')
          .select('id', { count: 'exact', head: true })
          .eq('automation_id', automation.id)
          .eq('contact_id', input.contactId)
          .gte('created_at', new Date(Date.now() - LOOP_GUARD_WINDOW_MS).toISOString())
        if ((count ?? 0) >= LOOP_GUARD_MAX_RUNS) {
          console.warn('[automations] loop guard: skipping', automation.id, input.triggerType)
          continue
        }
      }
      try {
        ran++
        await executeAutomation(automation, input)
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err)
      }
    }

    // Flows with this event as their trigger (migration 048) — same
    // events, same matching. A webhook URL that belongs to one automation
    // never starts flows (flows have their own URL).
    if (!input.automationId) {
      try {
        // Imported lazily: the flow engine imports this module.
        const { startFlowsForEvent } = await import('@/lib/flows/engine')
        ran += await startFlowsForEvent({
          accountId: input.accountId,
          triggerType: input.triggerType,
          contactId: input.contactId ?? null,
          context: input.context ?? {},
        })
      } catch (err) {
        console.error('[automations] flow dispatch failed:', err)
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err)
  }
  return ran
}

/** Who a step runs as when it comes from a Flow `action` node. */
export interface ActionStepSource {
  accountId: string
  userId: string
  /** e.g. `flow:<id>` — used in round-robin keys and audit text. */
  sourceId: string
  sourceName: string
  contactId: string | null
  conversationId?: string | null
  vars?: Record<string, unknown>
  messageText?: string
  trigger?: Record<string, unknown>
}

function actionArgs(src: ActionStepSource, triggerEvent: string): ExecuteArgs {
  return {
    automation: {
      id: src.sourceId,
      account_id: src.accountId,
      user_id: src.userId,
      name: src.sourceName,
    } as Automation,
    contactId: src.contactId,
    context: {
      conversation_id: src.conversationId ?? undefined,
      vars: { ...(src.vars ?? {}) },
      message_text: src.messageText,
      trigger: src.trigger,
    },
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: null,
    triggerEvent,
  }
}

/**
 * Run one Automation step for a Flow (the unified `action` node). Same
 * executor, so a converted automation behaves exactly as before.
 * Throws on failure; returns the log detail and the (possibly updated)
 * variables.
 */
export async function runActionStep(
  src: ActionStepSource,
  step: { key: string; type: AutomationStepType; config: Record<string, unknown> },
): Promise<{ detail: string; vars: Record<string, unknown> }> {
  if (step.type === 'wait' || step.type === 'wait_until' || step.type === 'condition') {
    throw new Error(`${step.type} is a flow step of its own, not an action`)
  }
  const args = actionArgs(src, 'flow')
  const detail = await runStep(
    { id: step.key, step_type: step.type, step_config: step.config } as unknown as AutomationStep,
    args,
  )
  if (detail.startsWith('unknown step:')) throw new Error(detail)
  return { detail, vars: args.context.vars ?? {} }
}

/** Evaluate an Automation condition rule for a Flow condition node. */
export async function evaluateActionRule(src: ActionStepSource, rule: ConditionStepConfig): Promise<boolean> {
  return evaluateCondition(rule, actionArgs(src, 'flow'))
}

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 */
export async function resumePendingExecution(pending: {
  id: string
  automation_id: string
  /** Audit-only; the automation row carries account_id for tenancy. */
  user_id: string
  /** Account-scoped lookups read from the automation row, so this
   *  field is just here to mirror the row shape and keep the cron's
   *  pass-through self-documenting. */
  account_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext
}): Promise<void> {
  const db = supabaseAdmin()
  const { data: automation, error } = await db
    .from('automations')
    .select('*')
    .eq('id', pending.automation_id)
    .single()

  if (error || !automation) {
    console.error('[automations] resume: missing automation', pending.automation_id, error)
    await markPending(pending.id, 'failed')
    return
  }

  try {
    // A wait inside a condition branch carries the enclosing scopes to
    // finish afterwards. Rows written before this field existed have
    // none and resume exactly as before.
    const { _continuations, ...context } = (pending.context ?? {}) as AutomationContext
    const chain: Continuation[] = Array.isArray(_continuations) ? _continuations : []
    const common = {
      automation: automation as Automation,
      contactId: pending.contact_id,
      context,
      logId: pending.log_id,
      triggerEvent: 'resumed_wait',
    }
    let outcome = await executeStepsFrom({
      ...common,
      parentStepId: pending.parent_step_id,
      branch: pending.branch,
      startPosition: pending.next_step_position,
      continuations: chain,
    })
    for (let i = 0; outcome !== 'suspended' && i < chain.length; i++) {
      const c = chain[i]
      const next = await executeStepsFrom({
        ...common,
        parentStepId: c.parentStepId,
        branch: c.branch,
        startPosition: c.nextPosition,
        continuations: chain.slice(i + 1),
      })
      outcome = next === 'done' && outcome === 'failed' ? 'failed' : next
    }
    if (outcome !== 'suspended' && chain.length && pending.log_id) {
      await setLogStatus(pending.log_id, outcome === 'failed' ? 'failed' : 'success')
    }
    await markPending(pending.id, 'done')
  } catch (err) {
    console.error('[automations] resume failed:', err)
    await markPending(pending.id, 'failed')
  }
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

async function executeAutomation(automation: Automation, input: DispatchInput) {
  const db = supabaseAdmin()

  const { data: log, error: logErr } = await db
    .from('automation_logs')
    .insert({
      automation_id: automation.id,
      // Tenancy: matches automation.account_id (NOT NULL post-017).
      account_id: automation.account_id,
      // Audit: keeps the historical "author of this automation"
      // pointer so logs still attribute to the right user even
      // after teammates join the account.
      user_id: automation.user_id,
      contact_id: input.contactId ?? null,
      trigger_event: input.triggerType,
      steps_executed: [],
      // Seeded pessimistically. The row is written BEFORE any step runs,
      // and every terminal path below overwrites it (`appendResults` at
      // the outermost scope, or `finalizeLog`). Seeding 'success' meant a
      // run that died mid-flight — the process frozen, the pod recycled —
      // left a permanent `status: 'success'` with `steps_executed: []`,
      // indistinguishable from an automation that genuinely had nothing
      // to do. 'failed' inverts that: the status only becomes success if
      // execution actually reached the end. See issue #409.
      status: 'failed',
    })
    .select()
    .single()

  if (logErr || !log) {
    console.error('[automations] cannot create log:', logErr)
    return
  }

  await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: input.context ?? {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
  })

  // Atomic counter update via the SQL function from migration 007.
  // Doing this with a client-side read-modify-write raced when the
  // same automation fired for two contacts simultaneously — both
  // would read N and both write N+1, losing one count permanently.
  const { error: rpcErr } = await db.rpc('increment_automation_execution_count', {
    p_automation_id: automation.id,
  })
  if (rpcErr) {
    console.error('[automations] increment counter failed:', rpcErr)
  }
}

interface ExecuteArgs {
  automation: Automation
  contactId: string | null
  context: AutomationContext
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  startPosition: number
  logId: string | null
  triggerEvent: string
  /** Enclosing scopes still to run after this one (for nested waits). */
  continuations?: Continuation[]
}

type ScopeOutcome = 'done' | 'suspended' | 'failed'

async function executeStepsFrom(args: ExecuteArgs): Promise<ScopeOutcome> {
  const db = supabaseAdmin()

  const baseQuery = db
    .from('automation_steps')
    .select('*')
    .eq('automation_id', args.automation.id)
    .gte('position', args.startPosition)
    .order('position', { ascending: true })

  const scoped =
    args.parentStepId === null
      ? baseQuery.is('parent_step_id', null)
      : baseQuery.eq('parent_step_id', args.parentStepId).eq('branch', args.branch ?? 'yes')

  const { data: steps, error: stepsErr } = await scoped

  if (stepsErr) {
    await finalizeLog(args.logId, 'failed', stepsErr.message)
    return 'failed'
  }
  if (!steps || steps.length === 0) {
    if (args.parentStepId === null && args.logId) {
      await finalizeLog(args.logId, 'success', null)
    }
    return 'done'
  }

  const results: AutomationLogStepResult[] = []
  let status: 'success' | 'partial' | 'failed' = 'success'
  let errorMessage: string | null = null

  for (const step of steps as AutomationStep[]) {
    // `wait` is the suspension point: enqueue and stop processing this
    // scope. The cron endpoint will pick it up later.
    if (step.step_type === 'wait' || step.step_type === 'wait_until') {
      let runAt: Date
      let detail: string
      if (step.step_type === 'wait') {
        const cfg = step.step_config as WaitStepConfig
        runAt = new Date(Date.now() + waitMs(cfg))
        detail = `waiting ${cfg.amount} ${cfg.unit}`
      } else {
        const cfg = step.step_config as WaitUntilStepConfig
        const at = await fill(cfg.at ?? '', args)
        const plan = planWaitUntil({ ...cfg, at }, new Date())
        if (!plan.ok) {
          results.push({ step_id: step.id, step_type: step.step_type, status: 'failed', detail: plan.error })
          status = 'failed'
          errorMessage = plan.error
          break
        }
        if (plan.past && cfg.if_past === 'skip') {
          results.push({ step_id: step.id, step_type: step.step_type, status: 'skipped', detail: 'time already passed' })
          continue
        }
        runAt = plan.past ? new Date() : plan.runAt
        detail = `waiting until ${runAt.toISOString()}`
      }
      await db.from('automation_pending_executions').insert({
        automation_id: args.automation.id,
        // Tenancy: account_id required NOT NULL post-017.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        contact_id: args.contactId,
        log_id: args.logId,
        parent_step_id: args.parentStepId,
        branch: args.branch,
        next_step_position: step.position + 1,
        context: args.continuations?.length
          ? { ...args.context, _continuations: args.continuations }
          : args.context,
        run_at: runAt.toISOString(),
        status: 'pending',
      })
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
      status = 'partial'
      await appendResults(args.logId, results, args.parentStepId === null ? status : null, errorMessage)
      return 'suspended'
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig
        const taken = await evaluateCondition(cfg, args)
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        })
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        const branchOutcome = await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
          // If the branch waits, the rest of THIS scope must run after it.
          continuations: [
            { parentStepId: args.parentStepId, branch: args.branch, nextPosition: step.position + 1 },
            ...(args.continuations ?? []),
          ],
        })
        if (branchOutcome === 'suspended') {
          // Previously the steps after the condition ran immediately
          // while the branch was still waiting.
          status = 'partial'
          await appendResults(args.logId, results, args.parentStepId === null ? status : null, errorMessage)
          return 'suspended'
        }
        if (branchOutcome === 'failed') {
          // Recorded (it was invisible before); later steps still run.
          status = 'failed'
          errorMessage = errorMessage ?? 'a step in a condition branch failed'
        }
        continue
      }

      const detail = await runStep(step, args)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      })
      status = 'failed'
      errorMessage = msg
      break
    }
  }

  if (args.parentStepId === null) {
    await appendResults(args.logId, results, status, errorMessage)
  } else {
    // Nested branch — just append results; parent scope decides final status.
    await appendResults(args.logId, results, null, errorMessage)
  }
  return status === 'failed' ? 'failed' : 'done'
}

async function runStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  const db = supabaseAdmin()

  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig
      if (!args.contactId) throw new Error('send_message needs a contact')
      const text = await fill(cfg.text, args)
      if (!text.trim()) throw new Error('send_message has empty text')
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      })
      return `sent via Meta (${whatsapp_message_id})`
    }

    case 'send_buttons':
    case 'send_list': {
      const payload = step.step_config as SendButtonsStepConfig | SendListStepConfig
      if (!args.contactId) throw new Error(`${step.step_type} needs a contact`)
      // Validate against Meta's limits before the network call so a bad
      // payload surfaces as a clear failed-step detail rather than a raw
      // Meta 400 mid-conversation.
      const check = validateInteractivePayload(payload)
      if (!check.ok) throw new Error(check.error)
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendInteractive({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        payload,
      })
      return `interactive sent via Meta (${whatsapp_message_id})`
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig
      if (!args.contactId) throw new Error('send_template needs a contact')
      if (!cfg.template_name) throw new Error('send_template needs template_name')
      const conversationId = await resolveConversationId(args)
      // Meta templates use positional {{1}}, {{2}}, … placeholders, so
      // we MUST emit params in strict numeric order. Lexicographic sort
      // of "1", "2", …, "10" yields "1", "10", "2", … which silently
      // scrambles every template with ≥10 variables.
      const params = cfg.variables
        ? Object.keys(cfg.variables)
            .sort((a, b) => {
              const na = Number(a)
              const nb = Number(b)
              const aNum = Number.isFinite(na)
              const bNum = Number.isFinite(nb)
              if (aNum && bNum) return na - nb
              if (aNum) return -1
              if (bNum) return 1
              return a.localeCompare(b)
            })
            .map((k) => String(cfg.variables![k]))
        : []
      for (let i = 0; i < params.length; i++) params[i] = await fill(params[i], args)
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      })
      return `template sent via Meta (${whatsapp_message_id})`
    }

    case 'add_tag': {
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('add_tag needs contact + tag_id')
      const added = await addContactTagIfAbsent(db, {
        accountId: args.automation.account_id,
        contactId: args.contactId,
        tagId: cfg.tag_id,
      })
      if (!added) return `tag ${cfg.tag_id} already present`

      const depth = getTagChainDepth(args.context)
      if (depth >= MAX_TAG_CHAIN_DEPTH) {
        console.warn('[automations] tag_added chain depth limit reached', {
          automationId: args.automation.id,
          contactId: args.contactId,
          tagId: cfg.tag_id,
          depth,
        })
        return `tag ${cfg.tag_id} added; tag_added dispatch skipped at depth ${depth}`
      }

      await runAutomationsForTrigger({
        accountId: args.automation.account_id,
        triggerType: 'tag_added',
        contactId: args.contactId,
        context: {
          ...args.context,
          tag_id: cfg.tag_id,
          vars: {
            ...(args.context.vars ?? {}),
            _tag_chain_depth: depth + 1,
          },
        },
      })
      return `tag ${cfg.tag_id} added and tag_added dispatched`
    }

    case 'remove_tag': {
      // See add_tag: tenant scoping relies on the runAutomationsForTrigger
      // ownership guard, since contact_tags carries no account_id.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('remove_tag needs contact + tag_id')
      await db
        .from('contact_tags')
        .delete()
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.tag_id)
      return `tag ${cfg.tag_id} removed`
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig
      if (!args.contactId) throw new Error('assign_conversation needs a contact')
      // Real round-robin (atomic DB cursor, eligible agents only) and a
      // random pool. `reassign` absent = true: older automations have
      // always overwritten an existing assignee.
      const r = await assignConversation(db, {
        accountId: args.automation.account_id,
        contactId: args.contactId,
        mode: cfg.mode ?? 'specific',
        agentId: cfg.agent_id,
        pool: cfg.pool,
        reassign: cfg.reassign !== false,
        poolKey: `automation:${args.automation.id}:${step.id}`,
      })
      if (r.status === 'no_agent') return `no agent resolved (${r.reason})`
      return r.status === 'kept' ? `already assigned to ${r.agentId}` : `assigned to ${r.agentId}`
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig
      if (!args.contactId) throw new Error('update_contact_field needs a contact')
      // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so custom
      // values can be populated dynamically from the triggering context.
      const value = await fill(cfg.value, args)

      // Custom fields are encoded as `custom:<custom_field_id>`; anything else
      // is a built-in contact column.
      if (cfg.field.startsWith('custom:')) {
        const customFieldId = cfg.field.slice('custom:'.length)
        if (!customFieldId) {
          return `field ${cfg.field} not writable from automations`
        }
        // Defense in depth: the service-role client bypasses RLS, so confirm
        // the field definition belongs to this account before writing.
        const { data: field } = await db
          .from('custom_fields')
          .select('id')
          .eq('id', customFieldId)
          .eq('account_id', args.automation.account_id)
          .maybeSingle()
        if (!field) {
          return `field ${cfg.field} not writable from automations`
        }
        // Upsert on the table's UNIQUE(contact_id, custom_field_id) so repeated
        // runs overwrite rather than duplicate. Tenancy is enforced above and,
        // for the contact side, by the entry-point ownership guard.
        await db
          .from('contact_custom_values')
          .upsert(
            { contact_id: args.contactId, custom_field_id: customFieldId, value },
            { onConflict: 'contact_id,custom_field_id' },
          )
        return `custom field updated`
      }

      const allowed = new Set(['name', 'email', 'company'])
      if (!allowed.has(cfg.field)) {
        return `field ${cfg.field} not writable from automations`
      }
      // Defense in depth: scope the service-role write to the account so
      // a future caller that skips the entry-point ownership guard still
      // cannot write across tenants.
      await db
        .from('contacts')
        .update({ [cfg.field]: value, updated_at: new Date().toISOString() })
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
      return `${cfg.field} updated`
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig
      if (!cfg.pipeline_id || !cfg.stage_id) throw new Error('create_deal needs pipeline + stage')
      // Match the account's configured default currency rather than
      // the static `deals.currency` DB default — keeps automation-
      // created deals consistent with the one-currency-per-account
      // rule (issue #218). Fall back to USD if the row is somehow
      // missing the value (pre-021 forks).
      const { data: acct } = await db
        .from('accounts')
        .select('default_currency')
        .eq('id', args.automation.account_id)
        .maybeSingle()
      await db.from('deals').insert({
        // Tenancy + audit, same split as automation_logs above.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        pipeline_id: cfg.pipeline_id,
        stage_id: cfg.stage_id,
        contact_id: args.contactId,
        title: await fill(cfg.title, args),
        value: cfg.value ?? 0,
        currency: acct?.default_currency ?? 'USD',
        status: 'open',
      })
      return 'deal created'
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error('send_webhook needs url')
      // SSRF guard: the URL and headers are account-controlled and the
      // server makes the request, so refuse any destination that resolves
      // to a private / loopback / link-local / reserved address. Mirrors
      // the webhook_endpoints delivery path (see lib/webhooks/deliver.ts).
      if (!(await isDeliverableUrl(cfg.url))) {
        throw new Error('send_webhook: destination not allowed')
      }
      const body = cfg.body_template ? await fill(cfg.body_template, args) : JSON.stringify(args.context)
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
        // Do NOT follow redirects — a public URL could 3xx-bounce to an
        // internal address, defeating the guard above. Bound the request
        // so a hung/slow internal host can't tie up the runner.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`webhook returned ${res.status}`)
      return `webhook ${res.status}`
    }

    case 'close_conversation': {
      if (!args.contactId) throw new Error('close_conversation needs a contact')
      await db
        .from('conversations')
        .update({ status: 'closed', updated_at: new Date().toISOString() })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId)
      return 'conversation closed'
    }

    case 'send_location': {
      const cfg = step.step_config as SendLocationStepConfig
      if (!args.contactId) throw new Error('send_location needs a contact')
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendLocation({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        latitude: Number(await fill(String(cfg.latitude ?? ''), args)),
        longitude: Number(await fill(String(cfg.longitude ?? ''), args)),
        name: (await fill(cfg.name ?? '', args)) || undefined,
        address: (await fill(cfg.address ?? '', args)) || undefined,
      })
      return `location sent via Meta (${whatsapp_message_id})`
    }

    case 'opt_out': {
      if (!args.contactId) throw new Error('opt_out needs a contact')
      const r = await optOutContact(db, {
        accountId: args.automation.account_id,
        contactId: args.contactId,
        source: `Automation "${args.automation.name}"`,
      })
      if (r === 'unsupported') throw new Error('opt-out needs database migration 044')
      return r === 'already' ? 'already opted out' : 'opted out of marketing'
    }

    case 'format_date':
    case 'format_phone': {
      const input = await fill(String((step.step_config as { input?: string }).input ?? ''), args)
      const res =
        step.step_type === 'format_date'
          ? (() => {
              const cfg = step.step_config as FormatDateStepConfig
              return formatDate(input, {
                inputFormat: cfg.input_format,
                inputTimezone: cfg.input_timezone,
                outputFormat: cfg.output_format,
                outputTimezone: cfg.output_timezone,
              })
            })()
          : (() => {
              const cfg = step.step_config as FormatPhoneStepConfig
              return formatPhone(input, { defaultCountryCode: cfg.default_country_code, output: cfg.output })
            })()
      if (!res.ok) throw new Error(res.error)
      const outVar = (step.step_config as { output_var?: string }).output_var || 'formatted'
      args.context.vars = { ...(args.context.vars ?? {}), [outVar]: res.value }
      return `vars.${outVar} = ${res.value.slice(0, 40)}`
    }

    case 'start_flow': {
      const cfg = step.step_config as StartFlowStepConfig
      if (!args.contactId) throw new Error('start_flow needs a contact')
      if (!cfg.flow_id) throw new Error('start_flow needs a flow')
      const conversationId = await resolveConversationId(args)
      // Imported lazily: the flow engine itself imports this module.
      const { startFlowForContact } = await import('@/lib/flows/engine')
      const r = await startFlowForContact({
        accountId: args.automation.account_id,
        flowId: cfg.flow_id,
        contactId: args.contactId,
        conversationId,
        userId: args.automation.user_id,
        source: `automation:${args.automation.id}`,
        replaceActive: cfg.replace_active === true,
      })
      if (!r.ok) {
        if (r.reason === 'contact_in_another_flow') return 'skipped: contact is already in a flow'
        throw new Error(`start_flow: ${r.reason}`)
      }
      return `flow run ${r.flow_run_id} started`
    }

    default:
      return `unknown step: ${step.step_type}`
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (it's the one that just got the inbound message);
 * fall back to the contact's conversation for resumed/wait paths and
 * manual engine POSTs. Throws if none exists — send steps have
 * no meaningful target without a conversation.
 */
async function resolveConversationId(args: ExecuteArgs): Promise<string> {
  const fromCtx = args.context.conversation_id
  if (fromCtx) return fromCtx
  if (!args.contactId) throw new Error('cannot resolve conversation: no contact')
  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('account_id', args.automation.account_id)
    .eq('contact_id', args.contactId)
    .maybeSingle()
  if (error) throw new Error(`conversation lookup failed: ${error.message}`)
  if (!data?.id) {
    const prefix = args.triggerEvent === 'tag_added'
      ? 'tag_added automation cannot send'
      : 'cannot send'
    throw new Error(`${prefix}: contact has no existing conversation`)
  }
  return data.id as string
}

// matchesWholeWord moved to lib/bot/keyword (shared with Flows and the
// browser simulator); re-exported here for existing imports.
export { matchesWholeWord } from '@/lib/bot/keyword'

export function triggerMatches(automation: Automation, ctx: AutomationContext | undefined): boolean {
  if (automation.trigger_type === 'keyword_match') {
    const cfg = automation.trigger_config as KeywordMatchTriggerConfig
    if (!cfg?.keywords || cfg.keywords.length === 0) return false
    const text = (ctx?.message_text ?? '').toString()
    if (!text) return false
    if (cfg.match_type === 'word') {
      return cfg.keywords.some((raw) =>
        matchesWholeWord(text, raw, cfg.case_sensitive),
      )
    }
    const haystack = cfg.case_sensitive ? text : text.toLowerCase()
    return cfg.keywords.some((raw) => {
      const k = cfg.case_sensitive ? raw : raw.toLowerCase()
      return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
    })
  }

  // Match on the tapped button / list-row id (exact). Lets multi-step
  // menus be chained: automation A sends buttons, automation B fires on
  // the reply id and sends the next step.
  if (automation.trigger_type === 'interactive_reply') {
    const cfg = automation.trigger_config as InteractiveReplyTriggerConfig
    const replyId = ctx?.interactive_reply_id
    if (!replyId || !Array.isArray(cfg?.reply_ids) || cfg.reply_ids.length === 0) {
      return false
    }
    return cfg.reply_ids.includes(replyId)
  }

  if (automation.trigger_type === 'tag_added') {
    const cfg = automation.trigger_config as TagTriggerConfig
    const tagId = ctx?.tag_id
    return Boolean(tagId && cfg?.tag_id && cfg.tag_id === tagId)
  }

  // Optional filters on the Bot Studio triggers — empty = any.
  if (automation.trigger_type === 'contact_field_changed') {
    const cfg = automation.trigger_config as ContactFieldChangedTriggerConfig
    if (cfg?.field && cfg.field !== ctx?.field) return false
    // Change mode (On Set First Time / Changed Anytime /
    // Removed). Uses the old/new values the outbox recorded.
    const empty = (v: unknown) => v == null || String(v).trim() === ''
    const before = ctx?.trigger?.old_value
    const after = ctx?.trigger?.new_value
    if (cfg?.change_mode === 'first_set') return empty(before) && !empty(after)
    if (cfg?.change_mode === 'removed') return !empty(before) && empty(after)
    return true
  }
  // Ad filter (migration 054): all ads, one campaign or one ad set (the
  // webhook resolves the ad into ctx.trigger.campaign_id / adset_id),
  // plus the legacy ad-id list.
  if (automation.trigger_type === 'ctwa_message') {
    const cfg = automation.trigger_config as CtwaTriggerConfig
    return ctwaAdMatches(cfg, ctx?.source_id, ctx?.trigger)
  }
  // Lead From CTWA (migration 051): a new contact from an ad, or, with
  // the legacy lead_mode 'new_ad', also a known contact's first chat
  // from this ad.
  if (automation.trigger_type === 'ctwa_lead') {
    const cfg = automation.trigger_config as CtwaTriggerConfig
    if (!ctwaAdMatches(cfg, ctx?.source_id, ctx?.trigger)) return false
    const lead = ctx?.trigger as { new_contact?: boolean; new_ad?: boolean } | undefined
    return cfg?.lead_mode === 'new_ad' ? Boolean(lead?.new_contact || lead?.new_ad) : Boolean(lead?.new_contact)
  }
  if (automation.trigger_type === 'template_delivered') {
    const cfg = automation.trigger_config as TemplateDeliveredTriggerConfig
    const names = (cfg?.template_names ?? []).filter(Boolean)
    return names.length === 0 || Boolean(ctx?.template_name && names.includes(ctx.template_name))
  }
  if (automation.trigger_type === 'conversation_assigned') {
    const cfg = automation.trigger_config as ConversationAssignedTriggerConfig
    return !cfg?.agent_id || cfg.agent_id === ctx?.agent_id
  }

  return true
}

async function evaluateCondition(cfg: ConditionStepConfig, args: ExecuteArgs): Promise<boolean> {
  const db = supabaseAdmin()
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false
      // contact_tags has no account_id column (its RLS keys off the parent
      // contact), so tenant scoping here relies on the contact-ownership
      // guard in runAutomationsForTrigger.
      const { count } = await db
        .from('contact_tags')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.operand)
      return (count ?? 0) > 0
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false
      // Scope to the account so the condition can't be turned into a
      // cross-tenant read oracle via the service-role client.
      const { data } = await db
        .from('contacts')
        .select(cfg.operand)
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle()
      const v = (data as Record<string, unknown> | null)?.[cfg.operand]
      return v != null && String(v) === String(cfg.value ?? '')
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString()
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase())
    }
    case 'time_of_day': {
      // operand form "HH:mm-HH:mm" — true if now is within that window
      // (supports over-midnight ranges like "18:00-09:00").
      const [from, to] = (cfg.operand ?? '').split('-')
      if (!from || !to) return false
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number)
        return (h || 0) * 60 + (m || 0)
      }
      const f = parse(from)
      const t = parse(to)
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t
    }
    case 'working_hours': {
      const state = workingHoursAt(new Date(), await loadBusinessHours(db, args.automation.account_id))
      return state === 'open'
    }
    default:
      return false
  }
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs = cfg.unit === 'days' ? 86_400_000 : cfg.unit === 'hours' ? 3_600_000 : 60_000
  return Math.max(1_000, cfg.amount * unitMs)
}

/**
 * Resolve {{…}} tokens. Same results as before for {{message.text}} and
 * {{vars.x}}; also {{contact.*}} (loaded only when used) and
 * {{trigger.*}} (webhook / event payload). Unknown tokens → "".
 */
async function fill(s: string, args: ExecuteArgs): Promise<string> {
  if (!s || !s.includes('{{')) return s ?? ''
  const want = needsContact(s)
  const contactScope =
    want.contact && args.contactId
      ? await loadContactScope(supabaseAdmin(), args.automation.account_id, args.contactId, want.custom)
      : {}
  return interpolateScope(s, {
    vars: args.context.vars,
    message: { text: args.context.message_text },
    trigger: args.context.trigger,
    ...contactScope,
  })
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null,
) {
  if (!logId) return
  const db = supabaseAdmin()
  const { data: existing } = await db
    .from('automation_logs')
    .select('steps_executed, status')
    .eq('id', logId)
    .single()
  const merged = [
    ...((existing?.steps_executed as AutomationLogStepResult[] | undefined) ?? []),
    ...newItems,
  ]
  const update: Record<string, unknown> = { steps_executed: merged }
  // Only overwrite status on the outermost scope — nested branches pass null.
  if (status !== null) {
    update.status = status
  }
  if (errorMessage) update.error_message = errorMessage
  await db.from('automation_logs').update(update).eq('id', logId)
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null,
) {
  if (!logId) return
  await supabaseAdmin()
    .from('automation_logs')
    .update({ status, error_message: errorMessage })
    .eq('id', logId)
}

async function setLogStatus(logId: string, status: 'success' | 'failed') {
  await supabaseAdmin().from('automation_logs').update({ status }).eq('id', logId)
}

async function markPending(id: string, status: 'done' | 'failed') {
  await supabaseAdmin()
    .from('automation_pending_executions')
    .update({ status })
    .eq('id', id)
}
