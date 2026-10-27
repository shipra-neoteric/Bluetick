// ============================================================
// GET /api/integrations/google/sheets — builder pickers (agent+).
//
//   ?spreadsheet=<url or id>              → { id, title, tabs }
//   ?spreadsheet=<id>&sheet=<tab name>    → { headers }
//   … &preview=1                          → { rows } first 6 rows, read-only
//
//   … &connection=<google connection id>  which Google account to use
//                                         (default: the oldest one)
//
// Nothing here imports, stores or sends anything.
//
// Requests go through one of the account's own Google connections, so
// users only see sheets that the chosen Google account can open.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { getAccessToken } from '@/lib/google/connection'
import { GoogleAuthError } from '@/lib/google/oauth'
import { SheetsApiError, getFirstRows, getHeaders, getSpreadsheetMeta, parseSpreadsheetId } from '@/lib/google/sheets'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

    const connection = q.get('connection')
    if (connection && !UUID.test(connection)) return NextResponse.json({ error: 'Pick a Google account.' }, { status: 400 })
    const token = await getAccessToken(supabaseAdmin(), accountId, connection)
    if (sheet && q.get('preview') === '1') {
      const rows = await getFirstRows(token, id, sheet, 6)
      // Cells are clipped: this is a glance, not an export.
      return NextResponse.json({ rows: rows.map((r) => r.slice(0, 30).map((v) => String(v ?? '').slice(0, 120))) })
    }
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
