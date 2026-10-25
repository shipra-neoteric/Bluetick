// ============================================================
// GET /api/integrations/google/watch?flow_id= — status of a flow's
// "On New Row Google Sheet" trigger (last check, rows started, error).
// RLS: members of the flow's account only.
// ============================================================

import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { isMissingSchemaError } from '@/lib/db/schema-compat'

export async function GET(request: Request) {
  try {
    const { supabase } = await getCurrentAccount()
    const flowId = new URL(request.url).searchParams.get('flow_id') ?? ''
    if (!/^[0-9a-f-]{36}$/i.test(flowId)) return NextResponse.json({ error: 'flow_id required' }, { status: 400 })
    const { data, error } = await supabase
      .from('google_sheet_watches')
      .select('last_checked_at, last_fired_at, rows_fired, last_error')
      .eq('flow_id', flowId)
      .maybeSingle()
    if (error) {
      if (isMissingSchemaError(error)) return NextResponse.json({ watch: null })
      throw error
    }
    return NextResponse.json({ watch: data ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}
