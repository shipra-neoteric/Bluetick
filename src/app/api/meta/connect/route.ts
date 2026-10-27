// ============================================================
// GET /api/meta/connect — start Facebook Login (agent+, like editing
// flows). `?popup=1` (Bot Builder / Settings popup) ends on a page that
// messages the opener instead of redirecting to Settings.
// A random state is kept in a short-lived httpOnly cookie and checked
// by the callback (CSRF protection).
// ============================================================

import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { META_COOKIE_PATH, META_STATE_COOKIE, buildAuthUrl, metaLoginConfigured } from '@/lib/meta/oauth'
import { metaPopupResult } from '@/lib/meta/popup'

export async function GET(request: Request) {
  const popup = new URL(request.url).searchParams.get('popup') === '1'
  try {
    await requireRole('agent')
    if (!metaLoginConfigured()) {
      return popup
        ? metaPopupResult({ result: 'not_configured' })
        : NextResponse.redirect(new URL('/settings?tab=integrations&meta=not_configured', request.url))
    }
    const state = randomBytes(24).toString('base64url')
    const res = NextResponse.redirect(buildAuthUrl(state, new URL(request.url).origin))
    // "<state>.<p|r>": tells the callback whether to answer as a popup.
    res.cookies.set(META_STATE_COOKIE, `${state}.${popup ? 'p' : 'r'}`, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: META_COOKIE_PATH,
      maxAge: 600,
    })
    return res
  } catch (err) {
    return popup ? metaPopupResult({ result: 'forbidden' }) : toErrorResponse(err)
  }
}
