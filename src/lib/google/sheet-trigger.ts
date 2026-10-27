/**
 * "On New Row Google Sheet" trigger (migrations 051 + 052). Polled by the
 * flows cron: for every active flow with this trigger, read the tab and
 * start the flow once per row appended since the last check.
 *
 *  - Append-only source: new rows are the ones below the saved cursor.
 *    Editing, sorting or deleting rows above it never re-fires them; a
 *    sheet that shrinks restarts from its new end and says so.
 *  - The first check after a flow is turned on (or its spreadsheet / tab
 *    changes) only records where the sheet ends: existing rows never fire.
 *    Turning a flow off forgets its position.
 *  - The tab is identified by Google's sheetId, so renaming it is safe.
 *  - Each row is claimed in google_sheet_row_log before its flow starts
 *    (unique key), so retries and overlapping cron calls never start the
 *    same row twice. The log also tells the trigger card why a row was
 *    skipped. A short lease (locked_until) serialises cron calls.
 *  - Identity: the phone column (normalised with an explicit default
 *    country code), else an optional WhatsApp user ID (BSUID) column that
 *    matches an existing contact, else an optional customer ID column (the
 *    Bluetick contact id) of this account. Nothing is guessed; unusable
 *    rows are skipped with a reason. A new row never changes consent or
 *    owner.
 *  - Each flow reads with the Google account it picked
 *    (google_connection_id, migration 053); older flows use the account's
 *    oldest connection. A connection that needs reconnecting is not called.
 */

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { formatPhone } from '@/lib/bot/formatters';
import { isMissingSchemaError } from '@/lib/db/schema-compat';
import { isBusinessScopedUserId } from '@/lib/whatsapp/wa-identity';
import { findOrCreateConversationForContact, resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import { getAccessToken } from './connection';
import { getAllRows, isBlankRow, letterHeaders, resolveTabTitle, rowToRecord } from './sheets';

/** Rows started per flow per cron call (the rest wait for the next call). */
const MAX_ROWS_PER_POLL = 25;
const LEASE_MS = 3 * 60_000;

export interface SheetTriggerConfig {
  /** Which of the account's Google connections reads the sheet (053). */
  google_connection_id?: string;
  spreadsheet_id?: string;
  spreadsheet_title?: string;
  sheet_name?: string;
  /** Google's stable sheetId of the tab (survives renames). */
  sheet_id?: number;
  /** false: row 1 is data and columns are "Column A", "Column B", … */
  first_row_header?: boolean;
  /** Header row as last loaded in the builder (for the variable picker). */
  headers?: string[];
  /** Header of the column holding the customer's WhatsApp number. */
  phone_column?: string;
  /** Optional fallback: WhatsApp user ID (BSUID) of an existing contact. */
  wa_user_id_column?: string;
  /** Optional last fallback: Bluetick contact id of this account. */
  customer_id_column?: string;
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
type StartFn = typeof import('@/lib/flows/engine').startFlowsForEvent;

export async function pollSheetTriggers(): Promise<{ checked: number; started: number; errors: number }> {
  const db = supabaseAdmin() as unknown as Db;
  const totals = { checked: 0, started: 0, errors: 0 };
  const connections = await loadConnections(db);
  if (!connections.length) return totals; // missing table (pre-051) or nobody connected
  // Accounts with at least one usable Google connection.
  const accounts = [...new Set(connections.filter((c) => !c.last_error).map((c) => c.account_id))];

  const { loadFlowsForTrigger, startFlowsForEvent } = await import('@/lib/flows/engine');
  for (const accountId of accounts) {
    const mine = connections.filter((c) => c.account_id === accountId);
    try {
      const flows = await loadFlowsForTrigger(accountId, 'google_sheet_new_row');
      // Forget positions of flows that are off or use another trigger now.
      const keep = flows.map((f) => f.id);
      let del = db.from('google_sheet_watches').delete().eq('account_id', accountId);
      if (keep.length) del = del.not('flow_id', 'in', `(${keep.join(',')})`);
      await del;

      for (const flow of flows) {
        totals.checked += 1;
        const cfg = flow.trigger_config as SheetTriggerConfig;
        const r = await pollOne(db, accountId, flow.id, cfg, startFlowsForEvent, connectionProblem(mine, cfg.google_connection_id));
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

export interface ConnectionInfo {
  id?: string;
  account_id: string;
  last_error: string | null;
}

/** Every Google connection (oldest first); tolerates a pre-053 database. */
async function loadConnections(db: Db): Promise<ConnectionInfo[]> {
  const res = await db.from('google_connections').select('id, account_id, last_error').order('connected_at', { ascending: true });
  if (!res.error) return (res.data ?? []) as ConnectionInfo[];
  if (!isMissingSchemaError(res.error)) return [];
  const old = await db.from('google_connections').select('account_id, last_error');
  return old.error ? [] : ((old.data ?? []) as ConnectionInfo[]);
}

/**
 * Why the flow's Google account cannot be used right now (so it is not
 * called), or null. Without a chosen id the oldest connection is used.
 */
export function connectionProblem(connections: ConnectionInfo[], connectionId?: string | null): string | null {
  const c = connectionId ? connections.find((x) => x.id === connectionId) : connections[0];
  if (!c) return 'The Google account chosen for this trigger was disconnected. Pick a Google account again.';
  if (c.last_error) return `${c.last_error} (Sign in with Google again in the trigger.)`;
  return null;
}

/** The watch row's source identity: sheetId when known, else the tab title. */
export function tabKeyOf(cfg: SheetTriggerConfig): string {
  return typeof cfg.sheet_id === 'number' && cfg.sheet_id >= 0 ? `#${cfg.sheet_id}` : cfg.sheet_name ?? '';
}

async function pollOne(
  db: Db,
  accountId: string,
  flowId: string,
  cfg: SheetTriggerConfig,
  start: StartFn,
  blocked: string | null,
): Promise<{ started: number; error?: string }> {
  if (!cfg.spreadsheet_id || !cfg.sheet_name || (!cfg.phone_column && !cfg.wa_user_id_column && !cfg.customer_id_column)) {
    return { started: 0, error: 'not configured' };
  }

  const watch = await claim(db, accountId, flowId);
  if (!watch) return { started: 0 }; // another cron call has it
  const tabKey = tabKeyOf(cfg);
  const hasHeader = cfg.first_row_header !== false;
  let started = 0;
  let lastError: string | null = null;
  let lastRow = watch.last_row;
  const fresh = watch.spreadsheet_id !== cfg.spreadsheet_id || watch.sheet_name !== tabKey || watch.last_row === 0;

  try {
    if (blocked) throw new Error(blocked);
    const token = await getAccessToken(db, accountId, cfg.google_connection_id);
    const tab = await resolveTabTitle(token, cfg.spreadsheet_id, cfg.sheet_name, cfg.sheet_id);
    const rows = await getAllRows(token, cfg.spreadsheet_id, tab);
    if (fresh) {
      // First look at this source: remember where the sheet ends, so rows
      // that were already there never start the flow.
      lastRow = Math.max(rows.length, hasHeader ? 1 : 0);
    } else if (rows.length < lastRow) {
      // Rows were deleted. The trigger reads appended rows only, so it
      // restarts from the new end instead of guessing which rows moved.
      lastRow = rows.length;
      lastError = 'Rows were deleted from the sheet, so the trigger restarted from the last row. Add new leads at the bottom only.';
    } else {
      const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
      const headers = hasHeader ? (rows[0] ?? []).map((h) => String(h ?? '')) : letterHeaders(width);
      const phoneIdx = cfg.phone_column ? findColumn(headers, cfg.phone_column) : -1;
      const nameIdx = cfg.name_column ? findColumn(headers, cfg.name_column) : -1;
      const waIdx = cfg.wa_user_id_column ? findColumn(headers, cfg.wa_user_id_column) : -1;
      const idIdx = cfg.customer_id_column ? findColumn(headers, cfg.customer_id_column) : -1;
      const missing = [
        cfg.phone_column && phoneIdx < 0 ? cfg.phone_column : null,
        cfg.wa_user_id_column && waIdx < 0 ? cfg.wa_user_id_column : null,
        cfg.customer_id_column && idIdx < 0 ? cfg.customer_id_column : null,
      ].filter(Boolean);
      // Header-less sheets grow columns as data arrives; only a header row
      // can lose a column.
      if (missing.length && hasHeader) {
        // Renamed/removed header: stop and report, never guess a column.
        lastError = `Column "${missing.join('", "')}" is not in the header row any more. Pick the column again.`;
      } else {
        const batch = rows.slice(lastRow, lastRow + MAX_ROWS_PER_POLL);
        for (const row of batch) {
          const rowNumber = lastRow + 1;
          if (!isBlankRow(row)) {
            const r = await startForRow(db, accountId, flowId, cfg, start, {
              headers,
              row,
              rowNumber,
              rowKey: rowKey(cfg.spreadsheet_id, tabKey, rowNumber, row),
              phone: phoneIdx >= 0 ? String(row[phoneIdx] ?? '') : '',
              waUserId: waIdx >= 0 ? String(row[waIdx] ?? '').trim() : '',
              customerId: idIdx >= 0 ? String(row[idIdx] ?? '').trim() : '',
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
      sheet_name: tabKey,
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

/** Stable identity of one appended row (see migration 052). */
export function rowKey(spreadsheetId: string, tabKey: string, rowNumber: number, row: unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify([spreadsheetId, tabKey, rowNumber, row.map((v) => (v == null ? '' : String(v)))]))
    .digest('hex');
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
  r: {
    headers: string[];
    row: unknown[];
    rowNumber: number;
    rowKey: string;
    phone: string;
    waUserId: string;
    customerId: string;
    name: string;
  },
): Promise<number | string | 'stop'> {
  // Claim the row first: a duplicate key means a retry or an overlapping
  // call already handled it, so it never starts twice.
  const log = await db
    .from('google_sheet_row_log')
    .insert({ flow_id: flowId, account_id: accountId, row_number: r.rowNumber, row_key: r.rowKey, status: 'started' })
    .select('id')
    .maybeSingle();
  if (log.error) {
    if (log.error.code === '23505') return 0;
    // Pre-052 database: carry on without the log (the cursor still advances).
    if (!isMissingSchemaError(log.error)) return `could not record the row (${log.error.message})`;
  }
  const logId = (log.data as { id?: number } | null)?.id;
  const finish = async (status: 'started' | 'skipped' | 'failed', detail: string | null, contactId?: string) => {
    if (logId) await db.from('google_sheet_row_log').update({ status, detail, contact_id: contactId ?? null }).eq('id', logId);
  };

  const who = await resolveRowContact(db, accountId, cfg, r);
  if (who === 'stop') {
    // Not handled: release the claim so the row is retried later.
    if (logId) await db.from('google_sheet_row_log').delete().eq('id', logId);
    return 'stop';
  }
  if (typeof who === 'string') {
    await finish('skipped', who);
    return who;
  }
  try {
    const n = await start({
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
          phone: who.phone,
        },
      },
    });
    await finish(
      n > 0 ? 'started' : 'skipped',
      n > 0 ? null : 'the flow did not start (switched off, or the customer is already in this flow)',
      who.contactId,
    );
    return n;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finish('failed', msg.slice(0, 300), who.contactId);
    return msg;
  }
}

const CONTACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this cell a usable customer (contact) id? */
export function isContactId(value: string): boolean {
  return CONTACT_ID.test(value.trim());
}

/**
 * Who is this row about? The phone column first (normalised with the
 * default country code). If it is empty or unusable, the WhatsApp user
 * ID (BSUID) column matches an EXISTING contact only — a BSUID is never
 * turned into a phone number and never creates a contact. Last, the
 * customer ID column matches an existing contact of THIS account by id.
 */
async function resolveRowContact(
  db: Db,
  accountId: string,
  cfg: SheetTriggerConfig,
  r: { phone: string; waUserId: string; customerId: string; name: string },
): Promise<{ contactId: string; conversationId: string; phone: string | null } | string | 'stop'> {
  const phone = r.phone.trim() ? formatPhone(r.phone, { defaultCountryCode: cfg.default_country_code, output: 'e164' }) : null;
  if (phone?.ok) {
    try {
      const who = await resolveConversationByPhone(db, accountId, phone.value, r.name || null);
      return { contactId: who.contactId, conversationId: who.conversationId, phone: phone.value };
    } catch (err) {
      if (err instanceof SendMessageError && err.code === 'whatsapp_not_configured') return 'stop';
      return err instanceof Error ? err.message : String(err);
    }
  }
  if (r.waUserId && !isBusinessScopedUserId(r.waUserId)) {
    if (!r.customerId) return `"${r.waUserId.slice(0, 40)}" is not a WhatsApp user ID`;
  } else if (r.waUserId) {
    const { data } = await db.from('contacts').select('id').eq('account_id', accountId).eq('wa_user_id', r.waUserId).limit(1);
    const contactId = (data?.[0] as { id?: string } | undefined)?.id;
    if (contactId) return conversationFor(db, accountId, contactId);
    if (!r.customerId) return 'no contact has this WhatsApp user ID yet (it is known only after they message you)';
  }
  if (r.customerId) {
    if (!isContactId(r.customerId)) return `"${r.customerId.slice(0, 40)}" is not a customer ID`;
    // Scoped to the account: an id from another workspace never matches.
    const { data } = await db.from('contacts').select('id').eq('account_id', accountId).eq('id', r.customerId.trim()).limit(1);
    const contactId = (data?.[0] as { id?: string } | undefined)?.id;
    if (!contactId) return 'no customer has this customer ID in this account';
    return conversationFor(db, accountId, contactId);
  }
  if (phone && !phone.ok) return `phone "${r.phone.slice(0, 30)}": ${phone.error}`;
  return 'no phone number in this row';
}

async function conversationFor(
  db: Db,
  accountId: string,
  contactId: string,
): Promise<{ contactId: string; conversationId: string; phone: string | null } | string> {
  try {
    const conversationId = await findOrCreateConversationForContact(db, accountId, contactId);
    return { contactId, conversationId, phone: null };
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
