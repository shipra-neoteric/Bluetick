// ============================================================
// /api/integrations/google — the account's Google Sheets connection
// (migration 051).
//
//   GET    → { configured, available, connected, email, connected_at, error }
//            (any member; tokens never leave the server)
//   DELETE → disconnect: revoke at Google, forget the tokens (admin+)
// ============================================================

import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { isMissingSchemaError } from '@/lib/db/schema-compat'
import { getConnectionStatus, removeConnection } from '@/lib/google/connection'
import { googleConfigured } from '@/lib/google/oauth'

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const db = supabaseAdmin()
    const probe = await db
      .from('google_connections')
      .select('account_id', { head: true, count: 'exact' })
      .eq('account_id', accountId)
    if (probe.error && isMissingSchemaError(probe.error)) {
      return NextResponse.json({ configured: googleConfigured(), available: false, connected: false })
    }
    const status = await getConnectionStatus(db, accountId)
    return NextResponse.json({ configured: googleConfigured(), available: true, ...status })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const { accountId } = await requireRole('admin')
    await removeConnection(supabaseAdmin(), accountId)
    return NextResponse.json({ disconnected: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
