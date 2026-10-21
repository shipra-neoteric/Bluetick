// ============================================================
// POST /api/automations/hooks/[token]
//
// Public receiver for an automation's "On Webhook" trigger. The URL
// token is the credential (random 192-bit, stored hashed; rotate it in
// the builder to revoke). JSON only, ≤ 64 KB, rate limited, replays
// deduplicated by Idempotency-Key (or body hash). Only the automation
// that owns the token can run, only while it is active.
//
// Capture mode (started from the builder): the payload is stored as a
// sanitized sample for field mapping and NOTHING runs.
// ============================================================

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { startFlowsForEvent } from '@/lib/flows/engine'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { findExistingContact } from '@/lib/contacts/dedupe'
import { formatPhone } from '@/lib/bot/formatters'
import {
  MAX_WEBHOOK_BODY_BYTES,
  dedupeKey,
  hashToken,
  sanitizeSample,
  valueAtPath,
} from '@/lib/bot/inbound-webhook'
import type { IncomingWebhookTriggerConfig } from '@/types'

export const maxDuration = 60

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params
  if (!token || token.length < 20 || token.length > 100) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const limit = checkRateLimit(`automation-hook:${token.slice(0, 12)}`, { limit: 60, windowMs: 60_000 })
  if (!limit.success) return rateLimitResponse(limit)

  const length = Number(request.headers.get('content-length') ?? 0)
  if (length > MAX_WEBHOOK_BODY_BYTES) return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  const raw = await request.text()
  if (raw.length > MAX_WEBHOOK_BODY_BYTES) return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 })
  }

  const db = supabaseAdmin()

  // Flow URLs (migration 048) first; the table is absent before 048.
  const { data: flowHook } = await db
    .from('flow_webhooks')
    .select('flow_id, account_id, capture_until')
    .eq('token_hash', hashToken(token))
    .maybeSingle()
  if (flowHook) return receiveForFlow(request, raw, body, flowHook as FlowHook)

  const { data: hook } = await db
    .from('automation_webhooks')
    .select('automation_id, account_id, capture_until')
    .eq('token_hash', hashToken(token))
    .maybeSingle()
  if (!hook) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const h = hook as { automation_id: string; account_id: string; capture_until: string | null }

  if (h.capture_until && Date.parse(h.capture_until) > Date.now()) {
    await db
      .from('automation_webhooks')
      .update({ last_sample: sanitizeSample(body), last_sample_at: new Date().toISOString(), capture_until: null })
      .eq('automation_id', h.automation_id)
    return NextResponse.json({ captured: true }, { status: 202 })
  }

  const { data: automation } = await db
    .from('automations')
    .select('id, is_active, trigger_type, trigger_config, account_id')
    .eq('id', h.automation_id)
    .eq('account_id', h.account_id)
    .maybeSingle()
  const a = automation as {
    is_active: boolean
    trigger_type: string
    trigger_config: IncomingWebhookTriggerConfig
  } | null
  if (!a || a.trigger_type !== 'incoming_webhook') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (!a.is_active) return NextResponse.json({ error: 'Automation is turned off' }, { status: 409 })

  const who = await resolveContact(h.account_id, a.trigger_config ?? ({} as IncomingWebhookTriggerConfig), body)
  if ('error' in who) return who.error
  const contactId = who.contactId

  // Replay guard — recorded only for accepted requests, so a corrected
  // retry of a rejected payload is not mistaken for a duplicate.
  const { error: dupErr } = await db
    .from('automation_webhook_receipts')
    .insert({ automation_id: h.automation_id, dedupe_key: dedupeKey(request.headers, raw) })
  if (dupErr) {
    if (dupErr.code === '23505') return NextResponse.json({ duplicate: true }, { status: 200 })
    return NextResponse.json({ error: 'Could not record the request' }, { status: 500 })
  }

  const ran = await runAutomationsForTrigger({
    accountId: h.account_id,
    triggerType: 'incoming_webhook',
    automationId: h.automation_id,
    contactId,
    context: { trigger: asPayload(body) },
  })
  return NextResponse.json({ accepted: true, ran }, { status: 202 })
}

interface FlowHook {
  flow_id: string
  account_id: string
  capture_until: string | null
}

const asPayload = (body: unknown) =>
  (body && typeof body === 'object' ? body : { value: body }) as Record<string, unknown>

/** Same contract as the automation URL, for a Flow with "On Webhook". */
async function receiveForFlow(request: Request, raw: string, body: unknown, h: FlowHook) {
  const db = supabaseAdmin()
  if (h.capture_until && Date.parse(h.capture_until) > Date.now()) {
    await db
      .from('flow_webhooks')
      .update({ last_sample: sanitizeSample(body), last_sample_at: new Date().toISOString(), capture_until: null })
      .eq('flow_id', h.flow_id)
    return NextResponse.json({ captured: true }, { status: 202 })
  }
  const { data: flow } = await db
    .from('flows')
    .select('id, status, trigger_type, trigger_config')
    .eq('id', h.flow_id)
    .eq('account_id', h.account_id)
    .maybeSingle()
  const f = flow as { status: string; trigger_type: string; trigger_config: IncomingWebhookTriggerConfig } | null
  if (!f || f.trigger_type !== 'incoming_webhook') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (f.status !== 'active') return NextResponse.json({ error: 'Flow is turned off' }, { status: 409 })

  const who = await resolveContact(h.account_id, f.trigger_config ?? ({} as IncomingWebhookTriggerConfig), body)
  if ('error' in who) return who.error

  const { error: dupErr } = await db
    .from('flow_webhook_receipts')
    .insert({ flow_id: h.flow_id, dedupe_key: dedupeKey(request.headers, raw) })
  if (dupErr) {
    if (dupErr.code === '23505') return NextResponse.json({ duplicate: true }, { status: 200 })
    return NextResponse.json({ error: 'Could not record the request' }, { status: 500 })
  }
  const ran = await startFlowsForEvent({
    accountId: h.account_id,
    triggerType: 'incoming_webhook',
    flowId: h.flow_id,
    contactId: who.contactId,
    context: { trigger: asPayload(body) },
  })
  return NextResponse.json({ accepted: true, ran }, { status: 202 })
}

/** Who is this about? The mapped phone field identifies the contact. */
async function resolveContact(
  accountId: string,
  cfg: IncomingWebhookTriggerConfig,
  body: unknown,
): Promise<{ contactId: string } | { error: NextResponse }> {
  const db = supabaseAdmin()
  const h = { account_id: accountId }
  const rawPhone = valueAtPath(body, cfg.phone_path)
  const phone = formatPhone(String(rawPhone ?? ''), { defaultCountryCode: cfg.default_country_code })
  if (!phone.ok) {
    return { error: NextResponse.json({ error: `phone (${cfg.phone_path || 'not mapped'}): ${phone.error}` }, { status: 422 }) }
  }
  let contactId = (await findExistingContact(db, h.account_id, phone.value))?.id ?? null
  if (!contactId && cfg.create_contact) {
    const { data: owner } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', h.account_id)
      .eq('account_role', 'owner')
      .limit(1)
    const name = cfg.name_path ? valueAtPath(body, cfg.name_path) : null
    const row = {
      account_id: h.account_id,
      user_id: (owner?.[0] as { user_id?: string } | undefined)?.user_id,
      phone: phone.value,
      name: typeof name === 'string' ? name.slice(0, 200) : null,
      source: 'webhook',
    }
    const { data: created } = await db.from('contacts').insert(row).select('id').maybeSingle()
    contactId = (created as { id?: string } | null)?.id ?? null
  }
  if (!contactId) {
    return { error: NextResponse.json({ error: 'No contact with this phone number (enable "create contact" to add one)' }, { status: 422 }) }
  }
  return { contactId }
}
