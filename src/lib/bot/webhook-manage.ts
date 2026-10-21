// ============================================================
// Manage an inbound webhook URL — shared by
//   /api/automations/[id]/webhook  (automation_webhooks)
//   /api/flows/[id]/webhook        (flow_webhooks, migration 048)
//
//   GET   → { configured, url, capturing, last_sample, sample_paths }
//   POST  { action: 'create' | 'rotate' | 'capture' | 'stop_capture' }
//
// Agent role (same as editing automations). The token is stored hashed
// for lookup and encrypted (ENCRYPTION_KEY) so the URL can be shown again.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { isMissingSchemaError } from '@/lib/db/schema-compat'
import { CAPTURE_WINDOW_MS, hashToken, newWebhookToken, samplePaths } from '@/lib/bot/inbound-webhook'

export interface HookOwner {
  /** Parent table ('automations' | 'flows'). */
  parent: 'automations' | 'flows'
  /** Webhook table and its key column. */
  table: 'automation_webhooks' | 'flow_webhooks'
  key: 'automation_id' | 'flow_id'
  /** Migration that creates the table, for the "needs migration" error. */
  migration: string
}

export const AUTOMATION_HOOKS: HookOwner = { parent: 'automations', table: 'automation_webhooks', key: 'automation_id', migration: '047' }
export const FLOW_HOOKS: HookOwner = { parent: 'flows', table: 'flow_webhooks', key: 'flow_id', migration: '048' }

async function owns(o: HookOwner, accountId: string, id: string) {
  const { data } = await supabaseAdmin()
    .from(o.parent)
    .select('id')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  return Boolean(data)
}

function hookUrl(request: Request, token: string): string {
  const origin = new URL(request.url).origin
  return `${origin}/api/automations/hooks/${token}`
}

export async function getHook(o: HookOwner, request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requireRole('agent')
    const { id } = await context.params
    if (!(await owns(o, accountId, id))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const { data, error } = await supabaseAdmin()
      .from(o.table)
      .select('token_encrypted, capture_until, last_sample, last_sample_at, rotated_at')
      .eq(o.key, id)
      .maybeSingle()
    if (error) {
      if (isMissingSchemaError(error)) return NextResponse.json({ available: false })
      throw error
    }
    if (!data) return NextResponse.json({ available: true, configured: false })
    const row = data as {
      token_encrypted: string
      capture_until: string | null
      last_sample: unknown
      last_sample_at: string | null
      rotated_at: string
    }
    return NextResponse.json({
      available: true,
      configured: true,
      url: hookUrl(request, decrypt(row.token_encrypted)),
      capturing: Boolean(row.capture_until && Date.parse(row.capture_until) > Date.now()),
      last_sample: row.last_sample,
      last_sample_at: row.last_sample_at,
      sample_paths: row.last_sample ? samplePaths(row.last_sample) : [],
      rotated_at: row.rotated_at,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function postHook(o: HookOwner, request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { accountId, userId } = await requireRole('agent')
    const { id } = await context.params
    if (!(await owns(o, accountId, id))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const { action } = (await request.json().catch(() => ({}))) as { action?: string }
    const db = supabaseAdmin()

    if (action === 'create' || action === 'rotate') {
      const token = newWebhookToken()
      const row = {
        [o.key]: id,
        account_id: accountId,
        token_hash: hashToken(token),
        token_encrypted: encrypt(token),
        created_by: userId,
        rotated_at: new Date().toISOString(),
      }
      const { error } = await db.from(o.table).upsert(row, { onConflict: o.key })
      if (error) {
        if (isMissingSchemaError(error)) {
          return NextResponse.json({ error: `Webhook triggers need database migration ${o.migration}.` }, { status: 409 })
        }
        throw error
      }
      return NextResponse.json({ url: hookUrl(request, token) })
    }
    if (action === 'capture' || action === 'stop_capture') {
      const { error } = await db
        .from(o.table)
        .update({ capture_until: action === 'capture' ? new Date(Date.now() + CAPTURE_WINDOW_MS).toISOString() : null })
        .eq(o.key, id)
      if (error) throw error
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
