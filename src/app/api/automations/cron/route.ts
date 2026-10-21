import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution, runAutomationsForTrigger } from '@/lib/automations/engine'
import { resumeDueFlowRuns } from '@/lib/flows/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import type { AutomationTriggerType } from '@/types'
import { isMissingSchemaError } from '@/lib/db/schema-compat'
import { claimSlaBreaches } from '@/lib/bot/events'

/**
 * Automations worker, hit on a schedule (external pinger / Vercel Cron)
 * with `x-cron-secret` = `AUTOMATION_CRON_SECRET`. Each tick:
 *
 *   1. Resumes due waits (`automation_pending_executions`). With
 *      migration 047 rows are claimed by `claim_automation_pending`
 *      (SKIP LOCKED + lease), so a crashed worker's rows are retried;
 *      without it, the original select-then-claim path runs.
 *   2. Drains lifecycle events (assigned / opened / closed / field
 *      changed) captured by database triggers into automation_events.
 *   3. Flags SLA breaches once per waiting period and fires
 *      `sla_breached` automations.
 */
export const maxDuration = 60

const LIFECYCLE_TRIGGERS = new Set<AutomationTriggerType>([
  'conversation_assigned',
  'conversation_opened',
  'conversation_closed',
  'contact_field_changed',
])

interface PendingRow {
  id: string
  automation_id: string
  account_id: string
  user_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext | null
}

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  // ── 1. Waits ────────────────────────────────────────────────────
  let claimed: PendingRow[] = []
  const { data: leased, error: leaseErr } = await admin.rpc('claim_automation_pending', {
    p_limit: 50,
    p_lease_seconds: 300,
  })
  if (!leaseErr) {
    claimed = (leased ?? []) as PendingRow[]
  } else if (isMissingSchemaError(leaseErr)) {
    // Pre-047: original two-step claim.
    const { data: due, error } = await admin
      .from('automation_pending_executions')
      .select('*')
      .eq('status', 'pending')
      .lte('run_at', new Date().toISOString())
      .order('run_at', { ascending: true })
      .limit(50)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    for (const row of (due ?? []) as PendingRow[]) {
      const { data: claim } = await admin
        .from('automation_pending_executions')
        .update({ status: 'running' })
        .eq('id', row.id)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle()
      if (claim) claimed.push(row)
    }
  } else {
    return NextResponse.json({ error: leaseErr.message }, { status: 500 })
  }

  let processed = 0
  for (const row of claimed) {
    await resumePendingExecution({
      id: row.id,
      automation_id: row.automation_id,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id,
      user_id: row.user_id,
      contact_id: row.contact_id ?? null,
      log_id: row.log_id ?? null,
      parent_step_id: row.parent_step_id ?? null,
      branch: row.branch ?? null,
      next_step_position: row.next_step_position,
      context: row.context ?? {},
    })
    processed++
  }

  // ── 2. Lifecycle events ─────────────────────────────────────────
  let events = 0
  const { data: evRows, error: evErr } = await admin.rpc('claim_automation_events', {
    p_limit: 100,
    p_lease_seconds: 120,
  })
  if (!evErr) {
    for (const ev of (evRows ?? []) as {
      id: string
      account_id: string
      event_type: AutomationTriggerType
      contact_id: string | null
      conversation_id: string | null
      payload: Record<string, unknown>
    }[]) {
      if (LIFECYCLE_TRIGGERS.has(ev.event_type)) {
        await runAutomationsForTrigger({
          accountId: ev.account_id,
          triggerType: ev.event_type,
          contactId: ev.contact_id,
          context: {
            conversation_id: ev.conversation_id ?? undefined,
            agent_id: typeof ev.payload.agent_id === 'string' ? ev.payload.agent_id : undefined,
            field: typeof ev.payload.field === 'string' ? ev.payload.field : undefined,
            trigger: ev.payload,
          },
        })
      }
      await admin
        .from('automation_events')
        .update({ status: 'done', processed_at: new Date().toISOString() })
        .eq('id', ev.id)
      events++
    }
  } else if (!isMissingSchemaError(evErr)) {
    console.error('[automations cron] event claim failed:', evErr.message)
  }

  // ── 3. SLA breaches ─────────────────────────────────────────────
  let breaches = 0
  try {
    for (const b of await claimSlaBreaches(admin)) {
      await runAutomationsForTrigger({
        accountId: b.account_id,
        triggerType: 'sla_breached',
        contactId: b.contact_id,
        context: {
          conversation_id: b.conversation_id,
          trigger: { kind: b.kind, due_at: b.due_at },
        },
      })
      breaches++
    }
  } catch (err) {
    console.error('[automations cron] SLA scan failed:', err)
  }

  // ── 4. Flow delays (migration 048) ────────────────────────────────
  // This worker runs every minute, so timed flow steps resume on time
  // even when the flow sweep is scheduled less often.
  let flowResumes = 0
  try {
    flowResumes = await resumeDueFlowRuns()
  } catch (err) {
    console.error('[automations cron] flow resume failed:', err)
  }

  return NextResponse.json({ processed, events, sla_breaches: breaches, flow_resumes: flowResumes })
}
