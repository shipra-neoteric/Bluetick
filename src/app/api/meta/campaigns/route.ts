// ============================================================
// GET /api/meta/campaigns?connection=<id>&level=campaign|adset&q=
// Campaigns (or ad sets) across every ad account the connected Facebook
// user can see, for the "Lead From CTWA" trigger (agent+). Read-only.
// → { options: [{ id, name, status, ad_account_name, campaign_name? }] }
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { connectionToken, listCampaignOptions, markConnectionError, MetaGraphError } from '@/lib/meta/connections'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`meta-campaigns:${userId}`, { limit: 30, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)

    const params = new URL(request.url).searchParams
    const id = params.get('connection') ?? ''
    const level = params.get('level') === 'adset' ? 'adset' : 'campaign'
    const q = (params.get('q') ?? '').trim().slice(0, 100)
    if (!UUID.test(id)) return NextResponse.json({ error: 'connection is required' }, { status: 400 })

    const db = supabaseAdmin()
    const conn = await connectionToken(db, accountId, id)
    if (!conn) return NextResponse.json({ error: 'Facebook account not found' }, { status: 404 })
    try {
      const options = await listCampaignOptions(conn.token, level, q)
      return NextResponse.json({ options })
    } catch (err) {
      if (err instanceof MetaGraphError) {
        if (err.invalidToken) await markConnectionError(db, conn.id, err.message).catch(() => {})
        return NextResponse.json({ error: err.message, reconnect: err.invalidToken }, { status: 502 })
      }
      throw err
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
