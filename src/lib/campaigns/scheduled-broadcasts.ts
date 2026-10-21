/**
 * Scheduled-broadcast worker, driven by /api/broadcasts/cron.
 *
 * A scheduled broadcast is created by the wizard with its recipient rows
 * already frozen (status 'pending', params resolved) and status
 * 'scheduled'. When it falls due the worker:
 *
 *   1. claims it atomically (claim_due_scheduled_broadcasts, SKIP LOCKED
 *      — two overlapping cron ticks can never both send it);
 *   2. checks the template is still APPROVED. Pending/paused → put back
 *      to 'scheduled' with hold_reason (re-checked every 10 min).
 *      Rejected/disabled/missing → the broadcast fails, nothing is sent;
 *   3. runs the existing resume engine (planBroadcastResume +
 *      deliverBroadcast), which skips blocked / opted-out contacts and
 *      finalizes status from the recipient rows.
 *
 * A pass is capped (RESUME_MAX_PER_REQUEST). Larger campaigns stay
 * 'sending' with the lock released and are continued on later ticks.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingSchemaError } from '@/lib/db/schema-compat';
import {
  BroadcastError,
  deliverBroadcast,
  finalizeBroadcastStatus,
} from '@/lib/whatsapp/broadcast-core';
import {
  DELIVERY_LOCK_STALE_MS,
  claimBroadcastDelivery,
  planBroadcastResume,
  releaseBroadcastDelivery,
} from '@/lib/whatsapp/broadcast-resume';

export type TemplateGate = 'ok' | 'hold' | 'reject';

/** What to do with a due broadcast given its template's current status. */
export function templateGate(status: string | null | undefined): TemplateGate {
  const s = (status ?? '').toUpperCase();
  if (s === 'APPROVED') return 'ok';
  if (s === 'PENDING' || s === 'IN_APPEAL' || s === 'PAUSED') return 'hold';
  return 'reject';
}

export interface ScheduledOutcome {
  broadcastId: string;
  result: 'delivered' | 'continuing' | 'held' | 'failed' | 'empty';
  detail?: string;
}

export interface WorkerResult {
  outcomes: ScheduledOutcome[];
  /** True when migration 046 isn't applied — nothing can be scheduled. */
  notMigrated: boolean;
}

async function loadTemplateStatus(
  db: SupabaseClient,
  accountId: string,
  name: string,
  language: string | null,
): Promise<string | null> {
  let q = db
    .from('message_templates')
    .select('status, language')
    .eq('account_id', accountId)
    .eq('name', name);
  if (language) q = q.eq('language', language);
  const { data } = await q.limit(1);
  return ((data ?? [])[0] as { status?: string } | undefined)?.status ?? null;
}

/** Deliver one claimed broadcast. Always releases the lock. */
export async function processClaimedBroadcast(
  db: SupabaseClient,
  accountId: string,
  broadcastId: string,
  opts: { checkTemplate: boolean },
): Promise<ScheduledOutcome> {
  try {
    if (opts.checkTemplate) {
      const { data: bc } = await db
        .from('broadcasts')
        .select('template_name, template_language')
        .eq('id', broadcastId)
        .maybeSingle();
      const row = bc as { template_name: string; template_language: string | null } | null;
      if (!row) return { broadcastId, result: 'failed', detail: 'not_found' };

      const gate = templateGate(
        await loadTemplateStatus(db, accountId, row.template_name, row.template_language),
      );
      if (gate === 'hold') {
        await db
          .from('broadcasts')
          .update({
            status: 'scheduled',
            hold_reason: 'template_not_approved',
            hold_checked_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', broadcastId);
        return { broadcastId, result: 'held', detail: 'template_not_approved' };
      }
      if (gate === 'reject') {
        await db
          .from('broadcast_recipients')
          .update({ status: 'failed', error_message: 'Template is not approved by Meta' })
          .eq('broadcast_id', broadcastId)
          .eq('status', 'pending');
        await db
          .from('broadcasts')
          .update({
            status: 'failed',
            hold_reason: 'template_rejected',
            updated_at: new Date().toISOString(),
          })
          .eq('id', broadcastId);
        return { broadcastId, result: 'failed', detail: 'template_rejected' };
      }
    }

    let planned;
    try {
      planned = await planBroadcastResume(db, accountId, broadcastId, 'pending');
    } catch (err) {
      if (err instanceof BroadcastError && err.code === 'nothing_to_resume') {
        // Everyone was suppressed / unsendable, or a previous pass finished.
        await finalizeBroadcastStatus(db, broadcastId);
        return { broadcastId, result: 'empty' };
      }
      const code = err instanceof BroadcastError ? err.code : 'internal';
      await db
        .from('broadcasts')
        .update({ status: 'failed', hold_reason: code, updated_at: new Date().toISOString() })
        .eq('id', broadcastId);
      return { broadcastId, result: 'failed', detail: code };
    }

    await deliverBroadcast(db, planned.plan);
    return {
      broadcastId,
      result: planned.remaining > 0 ? 'continuing' : 'delivered',
    };
  } catch (err) {
    console.error(
      '[scheduled-broadcasts] delivery threw:',
      err instanceof Error ? err.message : err,
    );
    await finalizeBroadcastStatus(db, broadcastId).catch(() => {});
    return { broadcastId, result: 'failed', detail: 'exception' };
  } finally {
    await releaseBroadcastDelivery(db, broadcastId);
  }
}

/**
 * Drain due scheduled broadcasts, then continue scheduled campaigns that
 * are still 'sending' after a capped pass. Stops starting new work once
 * `deadline` (epoch ms) passes; anything left is picked up next tick.
 */
export async function runScheduledBroadcasts(
  db: SupabaseClient,
  deadline: number,
  now: () => number = Date.now,
): Promise<WorkerResult> {
  const outcomes: ScheduledOutcome[] = [];

  while (now() < deadline) {
    const { data, error } = await db.rpc('claim_due_scheduled_broadcasts', { p_limit: 1 });
    if (error) {
      if (isMissingSchemaError(error)) return { outcomes, notMigrated: true };
      console.error('[scheduled-broadcasts] claim failed:', error.message);
      break;
    }
    const claimed = (data ?? []) as { broadcast_id: string; account_id: string }[];
    if (!claimed.length) break;
    for (const c of claimed) {
      outcomes.push(
        await processClaimedBroadcast(db, c.account_id, c.broadcast_id, { checkTemplate: true }),
      );
    }
  }

  // Continuations: scheduled campaigns left 'sending' with pending rows
  // (capped pass, or a worker that died — its lock goes stale).
  if (now() < deadline) {
    const staleCutoff = new Date(now() - DELIVERY_LOCK_STALE_MS).toISOString();
    const { data } = await db
      .from('broadcasts')
      .select('id, account_id')
      .eq('status', 'sending')
      .not('scheduled_at', 'is', null)
      .or(`delivery_locked_at.is.null,delivery_locked_at.lt.${staleCutoff}`)
      .order('scheduled_at', { ascending: true })
      .limit(5);
    for (const row of (data ?? []) as { id: string; account_id: string }[]) {
      if (now() >= deadline) break;
      if (!(await claimBroadcastDelivery(db, row.account_id, row.id))) continue;
      outcomes.push(
        await processClaimedBroadcast(db, row.account_id, row.id, { checkTemplate: false }),
      );
    }
  }

  return { outcomes, notMigrated: false };
}
