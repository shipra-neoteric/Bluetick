// ============================================================
// /api/bot/apis — saved API definitions for the Bot Builder "Call Api"
// step (migration 049).
//
//   GET  → { available, apis: [...] }   (agents and above; RLS)
//   POST { name, method, url, headers, body, response_map } → { api }
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isMissingSchemaError } from '@/lib/db/schema-compat'
import { sanitizeApiInput } from '@/lib/bot/api-input'

const COLUMNS = 'id, name, method, url, headers, body, response_map, updated_at'

export async function GET() {
  try {
    const { supabase } = await requireRole('agent')
    const { data, error } = await supabase.from('api_definitions').select(COLUMNS).order('name')
    if (error) {
      if (isMissingSchemaError(error)) return NextResponse.json({ available: false, apis: [] })
      throw error
    }
    return NextResponse.json({ available: true, apis: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const parsed = sanitizeApiInput(await request.json().catch(() => null))
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const { data, error } = await supabase
      .from('api_definitions')
      .insert({ ...parsed.value, account_id: accountId, created_by: userId })
      .select(COLUMNS)
      .single()
    if (error) {
      if (isMissingSchemaError(error)) return NextResponse.json({ error: 'Call Api needs database migration 049.' }, { status: 409 })
      if (error.code === '23505') return NextResponse.json({ error: 'An API with this name already exists.' }, { status: 409 })
      throw error
    }
    return NextResponse.json({ api: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
