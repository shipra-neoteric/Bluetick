/**
 * Customers (the contacts table): data loading, column
 * definitions and export rows. The page and the export use the same
 * column `value` functions, so an exported cell always equals what the
 * table shows.
 *
 * Data comes from the `customer_page` RPC (migration 046), which adds
 * per-contact activity derived from conversations and messages. On a
 * database without 046 it falls back to a plain contacts query and the
 * derived columns show "—" (unknown), never a made-up value.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Contact } from '@/types';
import { isMissingSchemaError } from '@/lib/db/schema-compat';

export type CustomerSort = 'created_desc' | 'created_asc' | 'name_asc';

export interface CustomerContact extends Contact {
  source?: string | null;
  source_detail?: string | null;
  wa_profile_name?: string | null;
  last_ctwa_at?: string | null;
}

export interface CustomerRow {
  contact: CustomerContact;
  conversation_id: string | null;
  ticket_status: string | null;
  ticket_opened_at: string | null;
  ticket_closed_at: string | null;
  ticket_replied: boolean | null;
  first_message_received_at: string | null;
  first_message_sent_at: string | null;
  last_message_sent_at: string | null;
  last_template_sent_at: string | null;
  tagNames: string[];
  customValues: Record<string, string>;
}

export interface CustomerQuery {
  tagId: string | null;
  search: string;
  sort: CustomerSort;
  limit: number;
  offset: number;
}

export interface CustomerPage {
  rows: CustomerRow[];
  total: number;
  /** 'basic' = migration 046 not applied; activity columns unknown. */
  mode: 'full' | 'basic';
}

export const PAGE_MAX = 200;

const EMPTY_ACTIVITY = {
  conversation_id: null,
  ticket_status: null,
  ticket_opened_at: null,
  ticket_closed_at: null,
  ticket_replied: null,
  first_message_received_at: null,
  first_message_sent_at: null,
  last_message_sent_at: null,
  last_template_sent_at: null,
};

async function basicPage(db: SupabaseClient, q: CustomerQuery): Promise<{ rows: CustomerRow[]; total: number }> {
  const select = q.tagId ? '*, contact_tags!inner(tag_id)' : '*';
  let query = db.from('contacts').select(select, { count: 'exact' });
  if (q.tagId) query = query.eq('contact_tags.tag_id', q.tagId);
  const s = q.search.trim().replace(/[%,()]/g, ' ');
  if (s) query = query.or(`name.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%`);
  query =
    q.sort === 'name_asc'
      ? query.order('name', { ascending: true, nullsFirst: false })
      : query.order('created_at', { ascending: q.sort === 'created_asc' });
  const { data, count, error } = await query.range(q.offset, q.offset + Math.min(q.limit, PAGE_MAX) - 1);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as unknown as (CustomerContact & { contact_tags?: unknown })[]).map((c) => {
    const { contact_tags: _ct, ...contact } = c;
    void _ct;
    return { contact: contact as CustomerContact, ...EMPTY_ACTIVITY, tagNames: [], customValues: {} };
  });
  return { rows, total: count ?? rows.length };
}

/** One page of customers, enriched with tag names and custom values. */
export async function fetchCustomerPage(db: SupabaseClient, q: CustomerQuery): Promise<CustomerPage> {
  let rows: CustomerRow[];
  let total: number;
  let mode: CustomerPage['mode'] = 'full';

  const { data, error } = await db.rpc('customer_page', {
    p_tag_id: q.tagId,
    p_search: q.search.trim() || null,
    p_sort: q.sort,
    p_limit: Math.min(q.limit, PAGE_MAX),
    p_offset: q.offset,
  });
  if (error) {
    if (!isMissingSchemaError(error)) throw new Error(error.message);
    mode = 'basic';
    ({ rows, total } = await basicPage(db, q));
  } else {
    const raw = (data ?? []) as (Omit<CustomerRow, 'tagNames' | 'customValues'> & { total_count: number })[];
    total = raw.length ? Number(raw[0].total_count) : 0;
    rows = raw.map(({ total_count: _t, ...r }) => {
      void _t;
      return { ...r, tagNames: [], customValues: {} };
    });
  }

  const ids = rows.map((r) => r.contact.id);
  if (ids.length) {
    const [{ data: ct }, { data: cv }] = await Promise.all([
      db.from('contact_tags').select('contact_id, tag:tags(name)').in('contact_id', ids),
      db.from('contact_custom_values').select('contact_id, custom_field_id, value').in('contact_id', ids),
    ]);
    const byId = new Map(rows.map((r) => [r.contact.id, r]));
    for (const x of (ct ?? []) as unknown as { contact_id: string; tag: { name: string } | { name: string }[] | null }[]) {
      const tag = Array.isArray(x.tag) ? x.tag[0] : x.tag;
      if (tag?.name) byId.get(x.contact_id)?.tagNames.push(tag.name);
    }
    for (const x of (cv ?? []) as { contact_id: string; custom_field_id: string; value: string | null }[]) {
      const r = byId.get(x.contact_id);
      if (r && x.value != null) r.customValues[x.custom_field_id] = x.value;
    }
  }
  return { rows, total, mode };
}

// ── Columns ────────────────────────────────────────────────────────────

export type BuiltInColumn =
  | 'name' | 'phone' | 'email' | 'company' | 'waName' | 'tags' | 'source' | 'optStatus' | 'blocked'
  | 'createdAt' | 'firstReceived' | 'firstSent' | 'lastSent' | 'lastTemplateSent'
  | 'ticketStatus' | 'ticketOpened' | 'ticketClosed' | 'ticketReplied' | 'lastCtwa';

export const BUILT_IN_COLUMNS: BuiltInColumn[] = [
  'name', 'phone', 'email', 'company', 'waName', 'tags', 'source', 'optStatus', 'blocked',
  'createdAt', 'firstReceived', 'firstSent', 'lastSent', 'lastTemplateSent',
  'ticketStatus', 'ticketOpened', 'ticketClosed', 'ticketReplied', 'lastCtwa',
];

export const DEFAULT_COLUMNS: string[] = ['name', 'phone', 'tags', 'source', 'createdAt', 'lastSent', 'ticketStatus'];

/** Columns that only the 046 RPC can fill. */
export const ACTIVITY_COLUMNS = new Set<BuiltInColumn>([
  'firstReceived', 'firstSent', 'lastSent', 'lastTemplateSent', 'ticketStatus', 'ticketOpened', 'ticketClosed', 'ticketReplied',
]);

export const UNKNOWN = '—';

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return UNKNOWN;
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}

/**
 * Text value of a column for one row — shared by the table and export.
 * Custom-field columns are addressed as `cf:<field id>`.
 */
export function columnValue(row: CustomerRow, column: string, labels: { yes: string; no: string }): string {
  const c = row.contact;
  if (column.startsWith('cf:')) return row.customValues[column.slice(3)] || UNKNOWN;
  switch (column as BuiltInColumn) {
    case 'name': return c.name || UNKNOWN;
    case 'phone': return c.phone || UNKNOWN;
    case 'email': return c.email || UNKNOWN;
    case 'company': return c.company || UNKNOWN;
    case 'waName': return c.wa_profile_name || UNKNOWN;
    case 'tags': return row.tagNames.length ? row.tagNames.join(', ') : UNKNOWN;
    case 'source': return c.source || UNKNOWN;
    case 'optStatus': return c.opt_in_status || UNKNOWN;
    case 'blocked': return c.blocked_at === undefined ? UNKNOWN : c.blocked_at ? labels.yes : labels.no;
    case 'createdAt': return formatDateTime(c.created_at);
    case 'firstReceived': return formatDateTime(row.first_message_received_at);
    case 'firstSent': return formatDateTime(row.first_message_sent_at);
    case 'lastSent': return formatDateTime(row.last_message_sent_at);
    case 'lastTemplateSent': return formatDateTime(row.last_template_sent_at);
    case 'ticketStatus': return row.ticket_status || UNKNOWN;
    case 'ticketOpened': return formatDateTime(row.ticket_opened_at);
    case 'ticketClosed': return formatDateTime(row.ticket_closed_at);
    case 'ticketReplied': return row.ticket_replied === null ? UNKNOWN : row.ticket_replied ? labels.yes : labels.no;
    case 'lastCtwa': return formatDateTime(c.last_ctwa_at);
    default: return UNKNOWN;
  }
}

/** Every page of the current filter, for export. */
export async function fetchAllCustomers(
  db: SupabaseClient,
  q: Omit<CustomerQuery, 'limit' | 'offset'>,
  onProgress?: (done: number, total: number) => void,
): Promise<CustomerRow[]> {
  const out: CustomerRow[] = [];
  for (let offset = 0; ; offset += PAGE_MAX) {
    const page = await fetchCustomerPage(db, { ...q, limit: PAGE_MAX, offset });
    out.push(...page.rows);
    onProgress?.(out.length, page.total);
    if (page.rows.length < PAGE_MAX || out.length >= page.total) break;
  }
  return out;
}
