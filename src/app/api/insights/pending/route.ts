// GET /api/insights/pending — "Pending replies with window open" (AN-03).
// Conversations awaiting a human reply (the inbox's awaiting_reply_since)
// whose 24-hour window is open, waiting since the start of the period.
//   ?preset=last_7_days (default) | today | … &tz=<IANA>&agent=<id>

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadPendingWithWindow } from '@/lib/insights/metrics'
import { PRESETS, resolvePeriod, type Preset } from '@/lib/insights/period'

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const q = new URL(request.url).searchParams
    const preset = (q.get('preset') ?? 'last_7_days') as Preset
    if (!PRESETS.includes(preset)) return NextResponse.json({ error: 'Unknown period.' }, { status: 400 })
    const resolved = resolvePeriod({ preset, from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, tz: q.get('tz') ?? 'UTC' })
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 })
    const agent = q.get('agent') || null
    const count = await loadPendingWithWindow(supabase, accountId, resolved.period.from, agent)
    return NextResponse.json({ count, since: resolved.period.from, tz: resolved.period.tz, as_of: new Date().toISOString() })
  } catch (err) {
    return toErrorResponse(err)
  }
}
