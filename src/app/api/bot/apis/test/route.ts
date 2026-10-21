// ============================================================
// POST /api/bot/apis/test — "Test API" in the Call Api editor.
//
// Sends ONE real request to the endpoint the user typed, from the
// server, through the same SSRF-guarded runner as flows. It runs only
// when the user clicks Test (the flow simulator never calls APIs).
// Variables are filled from the sample values the user enters.
// Body: { name?, method, url, headers, body, response_map, sample?: {key: value} }
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { sanitizeApiInput } from '@/lib/bot/api-input'
import { performApiCall } from '@/lib/bot/call-api'
import { interpolate } from '@/lib/bot/variables'

export const maxDuration = 30

export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('agent')
    const limit = checkRateLimit(`api-test:${accountId}`, { limit: 20, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)
    const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const parsed = sanitizeApiInput({ name: 'test', ...(raw ?? {}) })
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const sample: Record<string, string> = {}
    for (const [k, v] of Object.entries((raw?.sample as Record<string, unknown>) ?? {}).slice(0, 50)) {
      if (/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(k)) sample[k] = String(v ?? '')
    }
    const result = await performApiCall(parsed.value, (t) => interpolate(t, { vars: sample }))
    const preview = typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2)
    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      error: result.error ?? null,
      mapped: result.mapped,
      body: preview?.slice(0, 8_000) ?? '',
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
