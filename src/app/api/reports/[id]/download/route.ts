// GET /api/reports/[id]/download — the stored workbook (RP-05).
// Authorisation is re-checked on every download (admin of the same
// account). Distinct answers: not_ready (409), failed (409), expired
// (410, file purged or past expiry — use Regenerate), missing (404).

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decodeBytea } from '@/lib/insights/generate'
import { XLSX_MIME } from '@/lib/insights/reports'

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requireRole('admin')
    const { id } = await context.params
    const { data, error } = await supabaseAdmin()
      .from('report_requests')
      .select('status, file_name, file_data, expires_at')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) throw error
    const row = data as { status: string; file_name: string | null; file_data: unknown; expires_at: string | null } | null
    if (!row) return NextResponse.json({ error: 'Report not found.', code: 'missing' }, { status: 404 })
    if (row.status === 'queued' || row.status === 'generating') {
      return NextResponse.json({ error: 'This report is still being generated.', code: 'not_ready' }, { status: 409 })
    }
    if (row.status === 'failed') return NextResponse.json({ error: 'This report failed. Generate it again.', code: 'failed' }, { status: 409 })
    const expired = !row.expires_at || Date.parse(row.expires_at) <= Date.now()
    const bytes = expired ? null : decodeBytea(row.file_data)
    if (!bytes) {
      return NextResponse.json({ error: 'Report expired. Regenerate it with the same settings.', code: 'expired' }, { status: 410 })
    }
    const name = (row.file_name ?? 'report.xlsx').replace(/[^A-Za-z0-9._-]/g, '_')
    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        'Content-Type': XLSX_MIME,
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
