// ============================================================
// GET /api/meta/callback — Facebook Login redirect.
// Checks the state cookie and that the signed-in user may still edit
// flows, swaps the code for a long-lived token, stores it (encrypted)
// with the person's name, then returns to Settings or, for the popup,
// messages the opener and closes.
// ============================================================

import { timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { saveConnection } from '@/lib/meta/connections'
import {
  ADS_READ_SCOPE,
  META_COOKIE_PATH,
  META_STATE_COOKIE,
  exchangeCode,
  fetchGrantedScopes,
  fetchMe,
} from '@/lib/meta/oauth'
import { metaPopupResult, type MetaPopupOutcome } from '@/lib/meta/popup'

function sameState(a: string, b: string) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y)
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const cookie = request.cookies.get(META_STATE_COOKIE)?.value ?? ''
  const dot = cookie.lastIndexOf('.')
  const expected = dot > 0 ? cookie.slice(0, dot) : ''
  const popup = dot > 0 && cookie.slice(dot + 1) === 'p'

  const done = (outcome: MetaPopupOutcome) => {
    const res = popup
      ? metaPopupResult(outcome)
      : NextResponse.redirect(new URL(`/settings?tab=integrations&meta=${outcome.result}`, request.url))
    res.cookies.set(META_STATE_COOKIE, '', { path: META_COOKIE_PATH, maxAge: 0 })
    return res
  }

  if (!sameState(url.searchParams.get('state') ?? '', expected)) return done({ result: 'invalid_state' })
  const code = url.searchParams.get('code')
  if (url.searchParams.get('error') || !code) return done({ result: 'denied' })

  let ctx: Awaited<ReturnType<typeof requireRole>>
  try {
    ctx = await requireRole('agent')
  } catch {
    return done({ result: 'forbidden' })
  }
  try {
    const token = await exchangeCode(code, new URL(request.url).origin)
    // The user can untick "ads_read" on Facebook's consent screen.
    const scopes = await fetchGrantedScopes(token.access_token).catch(() => [] as string[])
    if (!scopes.includes(ADS_READ_SCOPE)) return done({ result: 'missing_scope' })
    const me = await fetchMe(token.access_token)
    const id = await saveConnection(supabaseAdmin(), {
      accountId: ctx.accountId,
      userId: ctx.userId,
      token,
      fbUserId: me.id,
      name: me.name,
      scope: scopes,
    })
    return done({ result: 'connected', id, name: me.name })
  } catch (err) {
    console.error('[meta-oauth] callback failed:', err instanceof Error ? err.message : err)
    return done({ result: 'error' })
  }
}
