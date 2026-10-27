// ============================================================
// /api/integrations/google — the account's Google connections
// (migrations 051 + 053: several Google accounts per Bluetick account).
//
//   GET          → { configured, available, accounts: [{ id, email,
//                    connected_at, error, can_list }], connected, email,
//                    connected_at, error } (any member; the last four
//                    describe the oldest account, for older clients;
//                    tokens never leave the server)
//   DELETE ?id=  → disconnect that Google account: revoke at Google,
//                  forget the tokens (admin+)
// ============================================================

import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { isMissingSchemaError } from '@/lib/db/schema-compat'
import { getConnectionStatus, removeConnection } from '@/lib/google/connection'
import { googleConfigured } from '@/lib/google/oauth'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const db = supabaseAdmin()
    // Selecting `id` also detects a database without migration 053.
    const probe = await db
      .from('google_connections')
      .select('id', { head: true, count: 'exact' })
      .eq('account_id', accountId)
    if (probe.error && isMissingSchemaError(probe.error)) {
      return NextResponse.json({ configured: googleConfigured(), available: false, connected: false, accounts: [] })
    }
    const status = await getConnectionStatus(db, accountId)
    return NextResponse.json({ configured: googleConfigured(), available: true, ...status })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const { accountId } = await requireRole('admin')
    const id = new URL(request.url).searchParams.get('id') ?? ''
    if (!UUID.test(id)) return NextResponse.json({ error: 'id required' }, { status: 400 })
    const found = await removeConnection(supabaseAdmin(), accountId, id)
    if (!found) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ disconnected: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
