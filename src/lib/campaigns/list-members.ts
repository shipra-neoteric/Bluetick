/**
 * Broadcast-list membership. A broadcast list IS a tag (same as a
 * Customers segment / Contacts group), so membership is contact_tags and
 * goes through the existing /api/contacts/[id]/tags route (which also
 * fires "tag added" automations).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { addContactTag } from '@/lib/contacts/tag-api';
import { isMissingSchemaError } from '@/lib/db/schema-compat';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';

export const COUNTRY_CODES = ['+91', '+971', '+1', '+44', '+65', '+61', '+966', '+974', '+977', '+880'] as const;

/** "+91" + "98765 43210" → "+919876543210", or null when not a valid number. */
export function composePhone(countryCode: string, number: string): string | null {
  const local = number.replace(/[\s().-]/g, '');
  if (!local) return null;
  // A number pasted with its own +country code wins over the picker.
  const raw = local.startsWith('+') ? local : `${countryCode}${local.replace(/^0+/, '')}`;
  const digits = parseInternationalPhone(raw);
  return digits ? `+${digits}` : null;
}

export type AddMemberResult =
  | { ok: true; contactId: string; created: boolean; alreadyMember: boolean }
  | { ok: false; error: 'invalid_phone' | 'failed'; message?: string };

export async function addMemberToList(
  db: SupabaseClient,
  /** `tagId` null = just create / find the contact (Customers → All). */
  args: { accountId: string; userId: string; tagId: string | null; name: string; phone: string },
  tag: (contactId: string, tagId: string) => Promise<{ reason?: string }> = addContactTag,
): Promise<AddMemberResult> {
  const phone = parseInternationalPhone(args.phone) ? args.phone : null;
  if (!phone) return { ok: false, error: 'invalid_phone' };

  let existing = await findExistingContact(db, args.accountId, phone);
  let created = false;
  if (!existing) {
    const row = {
      user_id: args.userId,
      account_id: args.accountId,
      name: args.name.trim() || null,
      phone,
      source: 'manual',
    };
    let { data, error } = await db.from('contacts').insert(row).select('id, phone').single();
    if (error && isMissingSchemaError(error)) {
      // Pre-046: no `source` column.
      const { source: _s, ...legacy } = row;
      void _s;
      ({ data, error } = await db.from('contacts').insert(legacy).select('id, phone').single());
    }
    if (error && isUniqueViolation(error)) {
      existing = await findExistingContact(db, args.accountId, phone);
    } else if (error || !data) {
      return { ok: false, error: 'failed', message: error?.message };
    } else {
      existing = data as { id: string; phone: string };
      created = true;
    }
  }
  if (!existing) return { ok: false, error: 'failed' };
  if (!args.tagId) return { ok: true, contactId: existing.id, created, alreadyMember: !created };

  try {
    const res = await tag(existing.id, args.tagId);
    return { ok: true, contactId: existing.id, created, alreadyMember: res.reason === 'duplicate' };
  } catch (err) {
    return { ok: false, error: 'failed', message: err instanceof Error ? err.message : undefined };
  }
}
