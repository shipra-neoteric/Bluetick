// ============================================================
// GET /api/integrations/google/sheets — builder pickers (agent+).
//
//   ?spreadsheet=<url or id>              → { id, title, tabs }
//   ?spreadsheet=<id>&sheet=<tab name>    → { headers }
//
// Requests go through the account's own Google connection, so users
// only see sheets that the connected Google account can open.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { getAccessToken } from '@/lib/google/connection'
import { GoogleAuthError } from '@/lib/google/oauth'
import { SheetsApiError, getHeaders, getSpreadsheetMeta, parseSpreadsheetId } from '@/lib/google/sheets'

export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('agent')
    const limit = checkRateLimit(`google-sheets:${accountId}`, { limit: 60, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)

    const q = new URL(request.url).searchParams
    const id = parseSpreadsheetId(q.get('spreadsheet') ?? '')
    if (!id) {
      return NextResponse.json({ error: 'Paste the Google Sheets link (docs.google.com/spreadsheets/d/…).' }, { status: 400 })
    }
    const sheet = q.get('sheet')
    if (sheet !== null && (!sheet.trim() || sheet.length > 100)) {
      return NextResponse.json({ error: 'Pick a tab.' }, { status: 400 })
    }

    const token = await getAccessToken(supabaseAdmin(), accountId)
    if (sheet) return NextResponse.json({ headers: await getHeaders(token, id, sheet) })
    return NextResponse.json(await getSpreadsheetMeta(token, id))
  } catch (err) {
    if (err instanceof GoogleAuthError) return NextResponse.json({ error: err.message, reconnect: true }, { status: 409 })
    if (err instanceof SheetsApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status === 404 || err.status === 403 ? err.status : 502 })
    }
    return toErrorResponse(err)
  }
}
