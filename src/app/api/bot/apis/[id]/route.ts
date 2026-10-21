// /api/bot/apis/[id] — edit or delete a saved API definition (RLS-scoped).
// Flows that use a deleted API fail at that step with a clear reason
// (or take their Failure output); the editor flags them before publish.

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { sanitizeApiInput } from '@/lib/bot/api-input'

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase } = await requireRole('agent')
    const { id } = await context.params
    const parsed = sanitizeApiInput(await request.json().catch(() => null))
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const { data, error } = await supabase
      .from('api_definitions')
      .update({ ...parsed.value, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, name, method, url, headers, body, response_map, updated_at')
      .maybeSingle()
    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: 'An API with this name already exists.' }, { status: 409 })
      throw error
    }
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ api: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase } = await requireRole('agent')
    const { id } = await context.params
    const { data, error } = await supabase.from('api_definitions').delete().eq('id', id).select('id')
    if (error) throw error
    if (!data?.length) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
