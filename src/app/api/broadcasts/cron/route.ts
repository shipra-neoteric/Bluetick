import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runScheduledBroadcasts } from '@/lib/campaigns/scheduled-broadcasts'

/**
 * Send due scheduled broadcasts. Hit every minute by the same pinger as
 * /api/inbox/cron, with
 * `x-cron-secret` = `AUTOMATION_CRON_SECRET`.
 *
 * Safe to run concurrently: broadcasts are claimed with SKIP LOCKED and
 * continuations take the per-broadcast delivery lock.
 */
export const maxDuration = 300

// Stop starting new deliveries with headroom before maxDuration.
const WORK_BUDGET_MS = 240_000

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { outcomes, notMigrated } = await runScheduledBroadcasts(
      supabaseAdmin(),
      Date.now() + WORK_BUDGET_MS,
    )
    const count = (r: string) => outcomes.filter((o) => o.result === r).length
    return NextResponse.json({
      migration_046_applied: !notMigrated,
      processed: outcomes.length,
      delivered: count('delivered'),
      continuing: count('continuing'),
      held: count('held'),
      failed: count('failed'),
    })
  } catch (error) {
    console.error('[broadcast cron] worker failed:', error)
    return NextResponse.json({ error: 'worker failed' }, { status: 500 })
  }
}
