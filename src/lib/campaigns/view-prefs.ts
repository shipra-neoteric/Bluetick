/**
 * Per-user view preferences (column choices, list/card mode) stored in
 * user_view_preferences (migration 046). Falls back to this browser's
 * localStorage when the table isn't there yet, so the UI still works.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingSchemaError } from '@/lib/db/schema-compat';

const LOCAL_PREFIX = 'bluetick.view.';

function readLocal<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(LOCAL_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(LOCAL_PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage blocked — preference just won't persist.
  }
}

export async function loadViewPrefs<T extends object>(
  db: SupabaseClient,
  viewKey: string,
  fallback: T,
): Promise<T> {
  const { data, error } = await db
    .from('user_view_preferences')
    .select('prefs')
    .eq('view_key', viewKey)
    .maybeSingle();
  if (error) {
    if (!isMissingSchemaError(error)) console.error('[view-prefs] load failed:', error.message);
    return { ...fallback, ...(readLocal<T>(viewKey) ?? {}) };
  }
  const prefs = (data as { prefs?: T } | null)?.prefs;
  return prefs ? { ...fallback, ...prefs } : { ...fallback, ...(readLocal<T>(viewKey) ?? {}) };
}

export async function saveViewPrefs(
  db: SupabaseClient,
  ids: { userId: string; accountId: string },
  viewKey: string,
  prefs: object,
): Promise<void> {
  writeLocal(viewKey, prefs);
  const { error } = await db.from('user_view_preferences').upsert(
    {
      user_id: ids.userId,
      account_id: ids.accountId,
      view_key: viewKey,
      prefs,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,view_key' },
  );
  if (error && !isMissingSchemaError(error)) {
    console.error('[view-prefs] save failed:', error.message);
  }
}
