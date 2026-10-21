// ============================================================
// GET /api/insights/metric — one Insights chart/KPI value.
//   ?metric=response_time|replied|opened|closed
//   &preset=today|yesterday|last_7_days|last_30_days|custom[&from=YYYY-MM-DD&to=YYYY-MM-DD]
//   &tz=<IANA>&agent=<user id, optional>
// Any account member (like the dashboard). Always the caller's own
// account; the SQL also runs under row-level security.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isMissingSchemaError } from '@/lib/db/schema-compat'
import { loadMetric, METRICS, type Metric } from '@/lib/insights/metrics'
import { PRESETS, resolvePeriod, type Preset } from '@/lib/insights/period'

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const q = new URL(request.url).searchParams
    const metric = q.get('metric') as Metric
    if (!METRICS.includes(metric)) return NextResponse.json({ error: 'Unknown metric.' }, { status: 400 })
    const preset = (q.get('preset') ?? 'today') as Preset
    if (!PRESETS.includes(preset)) return NextResponse.json({ error: 'Unknown period.' }, { status: 400 })
    const resolved = resolvePeriod({ preset, from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, tz: q.get('tz') ?? 'UTC' })
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 })
    const agent = q.get('agent') || null
    if (agent && !/^[0-9a-f-]{36}$/i.test(agent)) return NextResponse.json({ error: 'Unknown agent.' }, { status: 400 })
    try {
      const result = await loadMetric(supabase, accountId, metric, resolved.period, agent)
      return NextResponse.json({
        ...result,
        period: { from: resolved.period.from, to: resolved.period.to, tz: resolved.period.tz, bucket: resolved.period.bucket, days: resolved.period.days },
      })
    } catch (err) {
      if (isMissingSchemaError(err)) return NextResponse.json({ error: 'Analytics needs database migration 050.', code: 'needs_migration' }, { status: 409 })
      throw err
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
