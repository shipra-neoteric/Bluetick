// ============================================================
// GET /api/bot-studio/explain?text=…&first=1
//
// Dry run: which Flow / Automation / AI would answer this message right
// now, plus keyword overlaps. Reads the account's active configuration
// (published flow triggers where a version exists); sends nothing.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { explainInbound, type ExplainFlow } from '@/lib/bot/explain'

export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('viewer')
    const url = new URL(request.url)
    const text = (url.searchParams.get('text') ?? '').slice(0, 1000)
    const firstInbound = url.searchParams.get('first') === '1'
    const db = supabaseAdmin()

    const [{ data: flows }, { data: automations }, { data: ai }] = await Promise.all([
      db
        .from('flows')
        .select('id, name, trigger_type, trigger_config, published_version, created_at')
        .eq('account_id', accountId)
        .eq('status', 'active')
        .order('created_at', { ascending: true }),
      db
        .from('automations')
        .select('id, name, trigger_type, trigger_config')
        .eq('account_id', accountId)
        .eq('is_active', true),
      db.from('ai_configs').select('is_active, auto_reply_enabled').eq('account_id', accountId).maybeSingle(),
    ])

    // Published snapshots decide the live trigger (migration 047).
    const list = (flows ?? []) as (ExplainFlow & { published_version?: number | null })[]
    const versioned = list.filter((f) => f.published_version)
    if (versioned.length) {
      const { data: versions } = await db
        .from('flow_versions')
        .select('flow_id, version, trigger_type, trigger_config')
        .in('flow_id', versioned.map((f) => f.id))
      for (const f of versioned) {
        const v = ((versions ?? []) as { flow_id: string; version: number; trigger_type: string; trigger_config: Record<string, unknown> }[])
          .find((x) => x.flow_id === f.id && x.version === f.published_version)
        if (v) {
          f.trigger_type = v.trigger_type
          f.trigger_config = v.trigger_config
        }
      }
    }

    const cfg = ai as { is_active?: boolean; auto_reply_enabled?: boolean } | null
    const result = explainInbound({
      text,
      firstInbound,
      flows: list,
      automations: (automations ?? []) as ExplainFlow[],
      ai: { configured: Boolean(cfg?.is_active), autoReply: Boolean(cfg?.auto_reply_enabled) },
    })
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
