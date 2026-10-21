// ============================================================
// /api/reports — report generation + request history (admins/owners).
//   GET  → { available, types, history: [...] }  (no file bytes)
//   POST { type, preset, from?, to?, tz, agent_id? } → { id } (201)
// Generation is synchronous for the allowed range (≤ 92 days) and is
// always recorded in history, Complete only once the file is stored.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isMissingSchemaError } from '@/lib/db/schema-compat'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { generateReport, type ReportParams } from '@/lib/insights/generate'
import { PRESETS, type Preset } from '@/lib/insights/period'
import { REPORT_TYPES, type ReportType } from '@/lib/insights/reports'

export const maxDuration = 60

export async function GET() {
  try {
    const { supabase } = await requireRole('admin')
    const { data, error } = await supabase
      .from('report_requests')
      .select('id, report_type, params, status, error, requested_by, requested_at, completed_at, file_name, file_size, expires_at, regenerated_from')
      .order('requested_at', { ascending: false })
      .limit(50)
    if (error) {
      if (isMissingSchemaError(error)) return NextResponse.json({ available: false, types: REPORT_TYPES, history: [] })
      throw error
    }
    return NextResponse.json({ available: true, types: REPORT_TYPES, history: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`reports:${accountId}`, { limit: 10, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)
    const b = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const type = b.type as ReportType
    if (!(type in REPORT_TYPES)) return NextResponse.json({ error: 'Unknown report.' }, { status: 400 })
    const preset = b.preset as Preset
    if (!PRESETS.includes(preset)) return NextResponse.json({ error: 'Choose a date range.' }, { status: 400 })
    const params: ReportParams = {
      preset,
      from: typeof b.from === 'string' ? b.from : undefined,
      to: typeof b.to === 'string' ? b.to : undefined,
      tz: typeof b.tz === 'string' ? b.tz : 'UTC',
      agent_id: typeof b.agent_id === 'string' && b.agent_id ? b.agent_id : null,
    }
    const r = await generateReport({ userDb: supabase, accountId, userId, type, params })
    if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status })
    return NextResponse.json({ id: r.id }, { status: 201 })
  } catch (err) {
    if (isMissingSchemaError(err)) return NextResponse.json({ error: 'Reports need database migration 050.' }, { status: 409 })
    return toErrorResponse(err)
  }
}
