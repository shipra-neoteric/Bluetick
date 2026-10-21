// ============================================================
// /api/flows/convert-automations — turn Automations into Flows
// (migration 048, "one Flow").
//
//   GET  → { available, pending: [{ id, name, trigger_type, is_active }] }
//   POST { ids?: string[] } → { converted: [{ automation_id, flow_id, notes }], failed }
//
// Admin only. Each automation is copied into an equivalent flow (same
// trigger, same steps via the shared executor, same on/off state); the
// automation is then switched OFF but kept, with a pointer to its flow,
// so it can be restored. Idempotent: an automation converts once
// (unique flows.source_automation_id). Its webhook URL moves with it.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { isMissingSchemaError } from '@/lib/db/schema-compat'
import { convertAutomationToFlow, type StepRowForConversion } from '@/lib/flows/convert-automation'
import { publishSnapshot } from '@/lib/flows/publish'

export const maxDuration = 60

export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const { data, error } = await supabaseAdmin()
      .from('automations')
      .select('id, name, trigger_type, is_active')
      .eq('account_id', accountId)
      .is('converted_flow_id', null)
      .order('created_at', { ascending: true })
    if (error) {
      if (isMissingSchemaError(error)) return NextResponse.json({ available: false, pending: [] })
      throw error
    }
    return NextResponse.json({ available: true, pending: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const body = (await request.json().catch(() => ({}))) as { ids?: unknown }
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : null
    const db = supabaseAdmin()

    let q = db
      .from('automations')
      .select('id, user_id, name, description, trigger_type, trigger_config, is_active')
      .eq('account_id', accountId)
      .is('converted_flow_id', null)
    if (ids) q = q.in('id', ids)
    const { data: automations, error } = await q
    if (error) {
      if (isMissingSchemaError(error)) {
        return NextResponse.json({ error: 'Converting needs database migration 048.' }, { status: 409 })
      }
      throw error
    }

    const converted: { automation_id: string; flow_id: string; name: string; notes: string[] }[] = []
    const failed: { automation_id: string; name: string; error: string }[] = []

    for (const a of (automations ?? []) as {
      id: string
      user_id: string
      name: string
      description: string | null
      trigger_type: string
      trigger_config: Record<string, unknown> | null
      is_active: boolean
    }[]) {
      try {
        const { data: steps, error: stepsErr } = await db
          .from('automation_steps')
          .select('id, step_type, step_config, position, parent_step_id, branch')
          .eq('automation_id', a.id)
        if (stepsErr) throw new Error(stepsErr.message)

        const f = convertAutomationToFlow(a, (steps ?? []) as StepRowForConversion[])
        const live = a.is_active && Boolean(f.entry_node_id)

        const { data: flow, error: flowErr } = await db
          .from('flows')
          .insert({
            user_id: a.user_id ?? userId,
            account_id: accountId,
            name: f.name,
            description: f.description,
            status: 'draft',
            trigger_type: f.trigger_type,
            trigger_config: f.trigger_config,
            entry_node_id: f.entry_node_id,
            source_automation_id: a.id,
          })
          .select('id')
          .single()
        if (flowErr || !flow) {
          // 23505: converted concurrently by someone else — skip quietly.
          if (flowErr?.code === '23505') continue
          throw new Error(flowErr?.message ?? 'flow insert failed')
        }
        const flowId = (flow as { id: string }).id

        if (f.nodes.length) {
          const { error: nodesErr } = await db.from('flow_nodes').insert(
            f.nodes.map((n) => ({ flow_id: flowId, node_key: n.node_key, node_type: n.node_type, config: n.config })),
          )
          if (nodesErr) {
            await db.from('flows').delete().eq('id', flowId)
            throw new Error(nodesErr.message)
          }
        }

        // Turn the automation off first, then the flow on, so the two
        // never both run for the same event.
        const { error: offErr } = await db
          .from('automations')
          .update({ is_active: false, converted_flow_id: flowId, updated_at: new Date().toISOString() })
          .eq('id', a.id)
          .eq('account_id', accountId)
        if (offErr) {
          await db.from('flows').delete().eq('id', flowId)
          throw new Error(offErr.message)
        }

        if (live) {
          const version = await publishSnapshot(db, flowId, userId)
          await db
            .from('flows')
            .update({
              status: 'active',
              ...(version ? { published_version: version, has_unpublished_changes: false } : {}),
            })
            .eq('id', flowId)
        }

        // Same URL keeps working: move the webhook token to the flow.
        if (a.trigger_type === 'incoming_webhook') {
          const { data: hook } = await db
            .from('automation_webhooks')
            .select('account_id, token_hash, token_encrypted, last_sample, last_sample_at, created_by, rotated_at')
            .eq('automation_id', a.id)
            .maybeSingle()
          if (hook) {
            await db.from('automation_webhooks').delete().eq('automation_id', a.id)
            const { error: hookErr } = await db.from('flow_webhooks').insert({ ...(hook as object), flow_id: flowId })
            if (hookErr) f.notes.push('The webhook URL could not be moved; generate a new one on the flow.')
          }
        }

        converted.push({ automation_id: a.id, flow_id: flowId, name: f.name, notes: f.notes })
      } catch (err) {
        failed.push({ automation_id: a.id, name: a.name, error: err instanceof Error ? err.message : String(err) })
      }
    }

    return NextResponse.json({ converted, failed })
  } catch (err) {
    return toErrorResponse(err)
  }
}
