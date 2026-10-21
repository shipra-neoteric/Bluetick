// POST /api/reports/[id]/regenerate — a NEW report with the stored
// parameters (RP-05). The old history row is kept unchanged.

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { generateReport, type ReportParams } from '@/lib/insights/generate'
import type { ReportType } from '@/lib/insights/reports'

export const maxDuration = 60

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const { id } = await context.params
    const { data } = await supabaseAdmin()
      .from('report_requests')
      .select('report_type, params')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    const row = data as { report_type: ReportType; params: ReportParams } | null
    if (!row) return NextResponse.json({ error: 'Report not found.', code: 'missing' }, { status: 404 })
    const r = await generateReport({ userDb: supabase, accountId, userId, type: row.report_type, params: row.params, regeneratedFrom: id })
    if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status })
    return NextResponse.json({ id: r.id }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
