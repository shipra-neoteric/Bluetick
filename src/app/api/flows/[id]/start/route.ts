// ============================================================
// POST /api/flows/[id]/start   { conversation_id, replace_active? }
//
// Manually start an active flow for one conversation ("manual" trigger,
// or any active flow an agent chooses from the inbox). Agent role.
// Refuses when the contact is already inside a flow unless the agent
// explicitly asks to replace that run.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { startFlowForContact } from '@/lib/flows/engine'

const REASONS: Record<string, { status: number; error: string }> = {
  flow_not_active: { status: 409, error: 'This flow is not active. Publish it first.' },
  flow_has_no_entry: { status: 409, error: 'This flow has no start step.' },
  conversation_not_found: { status: 404, error: 'Conversation not found.' },
  contact_in_another_flow: { status: 409, error: 'This customer is already inside a flow.' },
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { accountId, userId } = await requireRole('agent')
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as { conversation_id?: string; replace_active?: boolean }
    if (!body.conversation_id) {
      return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 })
    }
    const { data: conv } = await supabaseAdmin()
      .from('conversations')
      .select('contact_id')
      .eq('id', body.conversation_id)
      .eq('account_id', accountId)
      .maybeSingle()
    const contactId = (conv as { contact_id?: string } | null)?.contact_id
    if (!contactId) return NextResponse.json(REASONS.conversation_not_found, { status: 404 })

    const res = await startFlowForContact({
      accountId,
      flowId: id,
      contactId,
      conversationId: body.conversation_id,
      userId,
      source: `manual:${userId}`,
      replaceActive: body.replace_active === true,
    })
    if (!res.ok) {
      const r = REASONS[res.reason] ?? { status: 409, error: `Could not start: ${res.reason}` }
      return NextResponse.json({ error: r.error, code: res.reason }, { status: r.status })
    }
    return NextResponse.json({ ok: true, flow_run_id: res.flow_run_id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
