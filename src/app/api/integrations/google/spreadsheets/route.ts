// ============================================================
// GET /api/integrations/google/spreadsheets — spreadsheet picker
// (agent+, migration 053).
//
//   ?connection=<google connection id>&q=<name search>
//     → { files: [{ id, name, modifiedTime }] }
//
// Lists the Google Sheets files the chosen Google account can see (own,
// shared with it, shared drives), newest first, via Drive file metadata
// only — no file contents are read here.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { getAccessToken } from '@/lib/google/connection'
import { GoogleAuthError } from '@/lib/google/oauth'
import { SheetsApiError, listSpreadsheets } from '@/lib/google/sheets'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('agent')
    const limit = checkRateLimit(`google-sheets:${accountId}`, { limit: 60, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)

    const q = new URL(request.url).searchParams
    const connection = q.get('connection') ?? ''
    if (!UUID.test(connection)) return NextResponse.json({ error: 'Pick a Google account.' }, { status: 400 })
    const token = await getAccessToken(supabaseAdmin(), accountId, connection)
    return NextResponse.json({ files: await listSpreadsheets(token, q.get('q')) })
  } catch (err) {
    if (err instanceof GoogleAuthError) return NextResponse.json({ error: err.message, reconnect: true }, { status: 409 })
    if (err instanceof SheetsApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status === 403 ? 403 : 502 })
    }
    return toErrorResponse(err)
  }
}
