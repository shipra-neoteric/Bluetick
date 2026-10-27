// ============================================================
// GET /api/integrations/google/callback — Google OAuth redirect.
// Checks the state cookie and that the signed-in user may still edit
// flows (agent+), stores the (encrypted) tokens as one more Google
// account of this Bluetick account (or refreshes it), then returns to
// Settings — or, for a builder popup, tells the opener and closes.
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
  isPopupState,
} from '@/lib/google/oauth'
import { popupResult, type PopupOutcome } from '@/lib/google/popup'

function back(request: NextRequest, popup: boolean, outcome: PopupOutcome) {
  const res = popup
    ? popupResult(outcome)
    : NextResponse.redirect(new URL(`/settings?tab=integrations&google=${outcome.result}`, request.url))
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
  const state = url.searchParams.get('state') ?? ''
  const expected = request.cookies.get(GOOGLE_STATE_COOKIE)?.value ?? ''
  // Popup or not is read from the cookie, which the attacker cannot set.
  const popup = isPopupState(expected)
  if (!sameState(state, expected)) return back(request, popup, { result: 'invalid_state' })
  if (url.searchParams.get('error') || !code) return back(request, popup, { result: 'denied' })

  let ctx: Awaited<ReturnType<typeof requireRole>>
  try {
    ctx = await requireRole('agent')
  } catch {
    return back(request, popup, { result: 'forbidden' })
  }
  try {
    const tokens = await exchangeCode(code, url.origin)
    // The user can untick the Sheets permission on Google's consent screen.
    if (tokens.scope && !tokens.scope.split(' ').includes(SHEETS_SCOPE)) return back(request, popup, { result: 'missing_scope' })
    const email = await fetchGoogleEmail(tokens.access_token)
    const id = await saveConnection(supabaseAdmin(), { accountId: ctx.accountId, userId: ctx.userId, tokens, email })
    return back(request, popup, { result: 'connected', id, email })
  } catch (err) {
    console.error('[google-oauth] callback failed:', err instanceof Error ? err.message : err)
    return back(request, popup, { result: 'error' })
  }
}
