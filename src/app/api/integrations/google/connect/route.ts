// ============================================================
// GET /api/integrations/google/connect — start Google OAuth (agent+,
// the roles that may edit flows: they sign in from the Bot Builder).
// Each sign-in adds a Google account (or refreshes one already added).
//
//   ?popup=1 → the builder opened this in a popup; the callback answers
//              with a page that tells the opener and closes itself.
//
// A random state is kept in a short-lived httpOnly cookie and checked
// by the callback (CSRF protection).
// ============================================================

import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { GOOGLE_COOKIE_PATH, GOOGLE_STATE_COOKIE, buildAuthUrl, googleConfigured, oauthState } from '@/lib/google/oauth'
import { popupResult } from '@/lib/google/popup'

export async function GET(request: Request) {
  const popup = new URL(request.url).searchParams.get('popup') === '1'
  try {
    await requireRole('agent')
    if (!googleConfigured()) {
      if (popup) return popupResult({ result: 'not_configured' })
      return NextResponse.redirect(new URL('/settings?tab=integrations&google=not_configured', request.url))
    }
    const state = oauthState(randomBytes(24).toString('base64url'), popup)
    const res = NextResponse.redirect(buildAuthUrl(state, new URL(request.url).origin))
    res.cookies.set(GOOGLE_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: GOOGLE_COOKIE_PATH,
      maxAge: 600,
    })
    return res
  } catch (err) {
    if (popup) return popupResult({ result: 'forbidden' })
    return toErrorResponse(err)
  }
}
