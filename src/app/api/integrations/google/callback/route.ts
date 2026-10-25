// ============================================================
// GET /api/integrations/google/callback — Google OAuth redirect.
// Checks the state cookie and that the signed-in user is still an
// admin, stores the (encrypted) tokens, then returns to Settings.
// ============================================================

import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { saveConnection } from '@/lib/google/connection'
import {
  GOOGLE_COOKIE_PATH,
  GOOGLE_STATE_COOKIE,
  SHEETS_SCOPE,
  exchangeCode,
  fetchGoogleEmail,
} from '@/lib/google/oauth'

function back(request: NextRequest, result: string) {
  const res = NextResponse.redirect(new URL(`/settings?tab=integrations&google=${result}`, request.url))
  res.cookies.set(GOOGLE_STATE_COOKIE, '', { path: GOOGLE_COOKIE_PATH, maxAge: 0 })
  return res
}

function sameState(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y)
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const expected = request.cookies.get(GOOGLE_STATE_COOKIE)?.value ?? ''
  if (!sameState(url.searchParams.get('state') ?? '', expected)) return back(request, 'invalid_state')
  if (url.searchParams.get('error') || !code) return back(request, 'denied')

  let ctx: Awaited<ReturnType<typeof requireRole>>
  try {
    ctx = await requireRole('admin')
  } catch {
    return back(request, 'forbidden')
  }
  try {
    const tokens = await exchangeCode(code)
    // The user can untick the Sheets permission on Google's consent screen.
    if (tokens.scope && !tokens.scope.split(' ').includes(SHEETS_SCOPE)) return back(request, 'missing_scope')
    const email = await fetchGoogleEmail(tokens.access_token)
    await saveConnection(supabaseAdmin(), { accountId: ctx.accountId, userId: ctx.userId, tokens, email })
    return back(request, 'connected')
  } catch (err) {
    console.error('[google-oauth] callback failed:', err instanceof Error ? err.message : err)
    return back(request, 'error')
  }
}
