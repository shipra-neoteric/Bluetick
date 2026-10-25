/**
 * "On New Row Google Sheet" trigger (migration 051). Polled by the flows
 * cron: for every active flow with this trigger, read the tab and start
 * the flow once per row added since the last check.
 *
 *  - The first check after a flow is turned on (or its sheet / tab
 *    changes) only records where the sheet ends: existing rows never fire.
 *  - Turning a flow off forgets its position, so rows added while it was
 *    off do not fire when it is turned back on.
 *  - A short lease (locked_until) stops two overlapping cron calls from
 *    starting the same row twice; the cursor is saved after every row.
 *  - The row's phone column identifies the contact (created, with a
 *    conversation, if new). Rows without a usable phone are skipped and
 *    reported on the trigger card.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { formatPhone } from '@/lib/bot/formatters';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { getAccessToken } from './connection';
import { getAllRows, isBlankRow, rowToRecord } from './sheets';

/** Rows started per flow per cron call (the rest wait for the next call). */
const MAX_ROWS_PER_POLL = 25;
const LEASE_MS = 3 * 60_000;

export interface SheetTriggerConfig {
  spreadsheet_id?: string;
  spreadsheet_title?: string;
  sheet_name?: string;
  /** Header row as last loaded in the builder (for the variable picker). */
  headers?: string[];
  /** Header of the column holding the customer's WhatsApp number. */
  phone_column?: string;
  name_column?: string;
  default_country_code?: string;
}

interface WatchRow {
  flow_id: string;
  spreadsheet_id: string;
  sheet_name: string;
  last_row: number;
  rows_fired: number;
}

type Db = SupabaseClient;

export async function pollSheetTriggers(): Promise<{ checked: number; started: number; errors: number }> {
  const db = supabaseAdmin() as unknown as Db;
  const totals = { checked: 0, started: 0, errors: 0 };
  const { data: accounts, error } = await db.from('google_connections').select('account_id').is('last_error', null);
  if (error || !accounts?.length) return totals; // missing table (pre-051) or nobody connected

  const { loadFlowsForTrigger, startFlowsForEvent } = await import('@/lib/flows/engine');
  for (const { account_id: accountId } of accounts as { account_id: string }[]) {
    try {
      const flows = await loadFlowsForTrigger(accountId, 'google_sheet_new_row');
      // Forget positions of flows that are off or use another trigger now.
      const keep = flows.map((f) => f.id);
      let del = db.from('google_sheet_watches').delete().eq('account_id', accountId);
      if (keep.length) del = del.not('flow_id', 'in', `(${keep.join(',')})`);
      await del;

      for (const flow of flows) {
        totals.checked += 1;
        const r = await pollOne(db, accountId, flow.id, flow.trigger_config as SheetTriggerConfig, startFlowsForEvent);
        totals.started += r.started;
        if (r.error) totals.errors += 1;
      }
    } catch (err) {
      totals.errors += 1;
      console.error('[sheets-trigger] account poll failed:', accountId, err instanceof Error ? err.message : err);
    }
  }
  return totals;
}

type StartFn = typeof import('@/lib/flows/engine').startFlowsForEvent;

async function pollOne(
  db: Db,
  accountId: string,
  flowId: string,
  cfg: SheetTriggerConfig,
  start: StartFn,
): Promise<{ started: number; error?: string }> {
  if (!cfg.spreadsheet_id || !cfg.sheet_name || !cfg.phone_column) return { started: 0, error: 'not configured' };

  const watch = await claim(db, accountId, flowId);
  if (!watch) return { started: 0 }; // another cron call has it
  let started = 0;
  let lastError: string | null = null;
  let lastRow = watch.last_row;
  const fresh = watch.spreadsheet_id !== cfg.spreadsheet_id || watch.sheet_name !== cfg.sheet_name || watch.last_row === 0;

  try {
    const token = await getAccessToken(db, accountId);
    const rows = await getAllRows(token, cfg.spreadsheet_id, cfg.sheet_name);
    if (fresh || rows.length < lastRow) {
      // First look (or rows were deleted): remember where the sheet ends.
      lastRow = Math.max(rows.length, 1);
    } else {
      const headers = (rows[0] ?? []).map((h) => String(h ?? ''));
      const phoneIdx = findColumn(headers, cfg.phone_column);
      const nameIdx = cfg.name_column ? findColumn(headers, cfg.name_column) : -1;
      if (phoneIdx < 0) {
        lastError = `Column "${cfg.phone_column}" is not in the header row any more.`;
      } else {
        const batch = rows.slice(lastRow, lastRow + MAX_ROWS_PER_POLL);
        for (const row of batch) {
          const rowNumber = lastRow + 1;
          if (!isBlankRow(row)) {
            const r = await startForRow(db, accountId, flowId, cfg, start, {
              headers,
              row,
              rowNumber,
              phone: String(row[phoneIdx] ?? ''),
              name: nameIdx >= 0 ? String(row[nameIdx] ?? '').trim() : '',
            });
            if (r === 'stop') {
              lastError = 'WhatsApp is not connected, so new rows are waiting.';
              break;
            }
            if (typeof r === 'string') lastError = `Row ${rowNumber}: ${r}`;
            else started += r;
          }
          lastRow = rowNumber;
          await db.from('google_sheet_watches').update({ last_row: lastRow }).eq('flow_id', flowId);
        }
      }
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  const now = new Date().toISOString();
  await db
    .from('google_sheet_watches')
    .update({
      spreadsheet_id: cfg.spreadsheet_id,
      sheet_name: cfg.sheet_name,
      last_row: lastRow,
      locked_until: null,
      last_checked_at: now,
      last_error: lastError,
      updated_at: now,
      ...(started ? { last_fired_at: now, rows_fired: watch.rows_fired + started } : {}),
    })
    .eq('flow_id', flowId);
  return { started, error: lastError ?? undefined };
}

/** Lease the flow's watch row (creating it on first use). */
async function claim(db: Db, accountId: string, flowId: string): Promise<WatchRow | null> {
  const now = new Date();
  const until = new Date(now.getTime() + LEASE_MS).toISOString();
  const { data } = await db
    .from('google_sheet_watches')
    .update({ locked_until: until })
    .eq('flow_id', flowId)
    .or(`locked_until.is.null,locked_until.lt.${now.toISOString()}`)
    .select('flow_id, spreadsheet_id, sheet_name, last_row, rows_fired')
    .maybeSingle();
  if (data) return data as WatchRow;
  const { data: created, error } = await db
    .from('google_sheet_watches')
    .insert({ flow_id: flowId, account_id: accountId, spreadsheet_id: '', sheet_name: '', last_row: 0, locked_until: until })
    .select('flow_id, spreadsheet_id, sheet_name, last_row, rows_fired')
    .maybeSingle();
  // 23505 = the row exists and is leased by someone else.
  return error ? null : (created as WatchRow);
}

export function findColumn(headers: string[], name: string): number {
  const n = name.trim().toLowerCase();
  return headers.findIndex((h) => h.trim().toLowerCase() === n);
}

/** Started-run count, an error message to show, or 'stop' (retry later). */
async function startForRow(
  db: Db,
  accountId: string,
  flowId: string,
  cfg: SheetTriggerConfig,
  start: StartFn,
  r: { headers: string[]; row: unknown[]; rowNumber: number; phone: string; name: string },
): Promise<number | string | 'stop'> {
  const phone = formatPhone(r.phone, { defaultCountryCode: cfg.default_country_code, output: 'e164' });
  if (!phone.ok) return `phone "${r.phone.slice(0, 30)}": ${phone.error}`;
  let who: { contactId: string; conversationId: string };
  try {
    who = await resolveConversationByPhone(db, accountId, phone.value, r.name || null);
  } catch (err) {
    if (err instanceof SendMessageError && err.code === 'whatsapp_not_configured') return 'stop';
    return err instanceof Error ? err.message : String(err);
  }
  return start({
    accountId,
    triggerType: 'google_sheet_new_row',
    flowId,
    contactId: who.contactId,
    context: {
      conversation_id: who.conversationId,
      trigger: {
        row: rowToRecord(r.headers, r.row),
        row_number: r.rowNumber,
        spreadsheet_id: cfg.spreadsheet_id,
        spreadsheet_title: cfg.spreadsheet_title ?? null,
        sheet_name: cfg.sheet_name,
        phone: phone.value,
      },
    },
  });
}
