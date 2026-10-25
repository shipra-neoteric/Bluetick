// ============================================================
// GET /api/integrations/google/connect — start Google OAuth (admin+).
// A random state is kept in a short-lived httpOnly cookie and checked
// by the callback (CSRF protection).
// ============================================================

import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { GOOGLE_COOKIE_PATH, GOOGLE_STATE_COOKIE, buildAuthUrl, googleConfigured } from '@/lib/google/oauth'

export async function GET(request: Request) {
  try {
    await requireRole('admin')
    if (!googleConfigured()) {
      return NextResponse.redirect(new URL('/settings?tab=integrations&google=not_configured', request.url))
    }
    const state = randomBytes(24).toString('base64url')
    const res = NextResponse.redirect(buildAuthUrl(state))
    res.cookies.set(GOOGLE_STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: GOOGLE_COOKIE_PATH,
      maxAge: 600,
    })
    return res
  } catch (err) {
    return toErrorResponse(err)
  }
}
