// ============================================================
// /api/meta/connections — Facebook accounts connected for the
// "Lead From CTWA" trigger (migration 054). Names only, never tokens.
//   GET            list (agent+), plus whether Facebook Login is configured
//   DELETE ?id=    disconnect one (agent+, the same role that connects)
// A flow that picked a campaign through a removed account keeps working
// while another connected account can still read that campaign's ads.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { deleteConnection, listConnections } from '@/lib/meta/connections'
import { metaLoginConfigured } from '@/lib/meta/oauth'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The table does not exist yet (migration 054 not run). */
const missingTable = (err: unknown) => err instanceof Error && /meta_connections|does not exist|schema cache/i.test(err.message)

export async function GET() {
  try {
    const { accountId } = await requireRole('agent')
    try {
      const connections = await listConnections(supabaseAdmin(), accountId)
      return NextResponse.json({ configured: metaLoginConfigured(), available: true, connections })
    } catch (err) {
      if (missingTable(err)) return NextResponse.json({ configured: metaLoginConfigured(), available: false, connections: [] })
      throw err
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const { accountId } = await requireRole('agent')
    const id = new URL(request.url).searchParams.get('id') ?? ''
    if (!UUID.test(id)) return NextResponse.json({ error: 'id is required' }, { status: 400 })
    const removed = await deleteConnection(supabaseAdmin(), accountId, id)
    if (!removed) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
