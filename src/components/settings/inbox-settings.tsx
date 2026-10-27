'use client';

import { BusinessHoursPanel } from './business-hours-panel';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import { isMissingSchemaError } from '@/lib/db/schema-compat';
import { isClosedWindowTemplate } from '@/lib/inbox/closed-window';
import type { MessageTemplate } from '@/types';
import {
  DEFAULT_INBOX_SETTINGS,
  loadInboxSettings,
  type InboxSettings,
} from '@/lib/inbox/settings';

const ZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC'];

/**
 * Settings → Inbox: reopen policy, SLA response targets, display time
 * zone for scheduling, and the per-contact tag selection limit. Stored in
 * `inbox_settings` (migration 044); absent row = defaults (SLA off).
 * Admin+ only — RLS rejects writes from anyone else.
 */
export function InboxSettingsPanel() {
  const supabase = createClient();
  const { accountId, user } = useAuth();
  const canEdit = useCan('edit-settings');
  const [s, setS] = useState<InboxSettings>(DEFAULT_INBOX_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Approved templates with a single {{1}} — candidates for closed-window messages.
  const [cwTemplates, setCwTemplates] = useState<MessageTemplate[]>([]);

  useEffect(() => {
    if (!accountId) return;
    loadInboxSettings(supabase, accountId).then((v) => {
      setS(v);
      setLoading(false);
    });
    supabase
      .from('message_templates')
      .select('*')
      .eq('status', 'APPROVED')
      .order('name')
      .then(({ data }) => setCwTemplates(((data as MessageTemplate[] | null) ?? []).filter(isClosedWindowTemplate)));
  }, [supabase, accountId]);

  async function save() {
    if (!accountId) return;
    setSaving(true);
    const row = {
      account_id: accountId,
      ...s,
      updated_at: new Date().toISOString(),
      updated_by: user?.id ?? null,
    };
    let { error } = await supabase.from('inbox_settings').upsert(row, { onConflict: 'account_id' });
    let missing055 = false;
    if (error && isMissingSchemaError(error)) {
      // Migration 055 not applied: save everything else.
      const rest: Partial<typeof row> = { ...row };
      delete rest.closed_window_template;
      delete rest.closed_window_template_language;
      ({ error } = await supabase.from('inbox_settings').upsert(rest, { onConflict: 'account_id' }));
      missing055 = !error && !!s.closed_window_template;
    }
    setSaving(false);
    if (error) toast.error(`Could not save: ${error.message}`);
    else if (missing055) toast.warning('Saved, except the closed-window template — apply database migration 055 first.');
    else toast.success('Inbox settings saved');
  }

  const num = (v: string, min: number, max: number) =>
    Math.min(max, Math.max(min, Number.parseInt(v || '0', 10) || min));
  const field =
    'h-9 w-28 rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60';

  return (
    <div className="space-y-6">
      <SettingsPanelHead
        title="Inbox"
        description="How conversations reopen, response-time targets (SLA), scheduling time zone and tag limits."
      />
      {loading ? (
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      ) : (
        <div className="space-y-6 rounded-xl border border-border bg-card p-5">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 accent-primary"
              disabled={!canEdit}
              checked={s.reopen_on_inbound}
              onChange={(e) => setS({ ...s, reopen_on_inbound: e.target.checked })}
            />
            <span>
              <span className="block text-sm font-medium text-foreground">Reopen resolved chats when the customer writes</span>
              <span className="block text-xs text-muted-foreground">
                Off: a resolved chat stays resolved (it still shows as unread and awaiting reply).
              </span>
            </span>
          </label>

          <div className="space-y-3 border-t border-border pt-5">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 accent-primary"
                disabled={!canEdit}
                checked={s.sla_enabled}
                onChange={(e) => setS({ ...s, sla_enabled: e.target.checked })}
              />
              <span>
                <span className="block text-sm font-medium text-foreground">Track response-time SLA</span>
                <span className="block text-xs text-muted-foreground">
                  A chat breaches when a customer message waits longer than the target for a human reply.
                  Bot/automation messages, reading, tagging or assigning never stop the timer. Calendar time
                  (business hours are not applied).
                </span>
              </span>
            </label>
            <div className="flex flex-wrap gap-6 pl-7">
              <label className="space-y-1 text-xs text-muted-foreground">
                First response target (minutes)
                <input
                  type="number"
                  min={1}
                  max={10080}
                  className={`${field} block`}
                  disabled={!canEdit || !s.sla_enabled}
                  value={s.sla_first_response_minutes}
                  onChange={(e) => setS({ ...s, sla_first_response_minutes: num(e.target.value, 1, 10080) })}
                />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                Next response target (minutes)
                <input
                  type="number"
                  min={1}
                  max={10080}
                  className={`${field} block`}
                  disabled={!canEdit || !s.sla_enabled}
                  value={s.sla_next_response_minutes}
                  onChange={(e) => setS({ ...s, sla_next_response_minutes: num(e.target.value, 1, 10080) })}
                />
              </label>
            </div>
          </div>

          <div className="flex flex-wrap gap-6 border-t border-border pt-5">
            <label className="space-y-1 text-xs text-muted-foreground">
              Scheduling time zone
              <select
                className="block h-9 rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
                disabled={!canEdit}
                value={s.timezone}
                onChange={(e) => setS({ ...s, timezone: e.target.value })}
              >
                {(ZONES.includes(s.timezone) ? ZONES : [s.timezone, ...ZONES]).map((z) => (
                  <option key={z} value={z}>{z}</option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              Max tags per contact
              <input
                type="number"
                min={1}
                max={500}
                className={`${field} block`}
                disabled={!canEdit}
                value={s.tag_selection_limit}
                onChange={(e) => setS({ ...s, tag_selection_limit: num(e.target.value, 1, 500) })}
              />
            </label>
          </div>

          <div className="space-y-2 border-t border-border pt-5">
            <span className="block text-sm font-medium text-foreground">Message customers in a closed window</span>
            <span className="block text-xs text-muted-foreground">
              After 24 hours without a customer message, WhatsApp only allows templates. Pick an approved template
              whose body has a single {'{{1}}'} (e.g. &ldquo;Hello, {'{{1}}'} Your chat support request is
              registered.&rdquo;) and agents can type the {'{{1}}'} part in the chat box — it is sent as that template.
            </span>
            <select
              className="block h-9 w-full max-w-md rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
              disabled={!canEdit}
              value={s.closed_window_template ? `${s.closed_window_template}|${s.closed_window_template_language ?? ''}` : ''}
              onChange={(e) => {
                const [name, language] = e.target.value.split('|');
                setS({
                  ...s,
                  closed_window_template: name || null,
                  closed_window_template_language: name ? language || null : null,
                });
              }}
            >
              <option value="">Off — agents pick a template</option>
              {s.closed_window_template &&
                !cwTemplates.some(
                  (x) => x.name === s.closed_window_template && (x.language ?? '') === (s.closed_window_template_language ?? ''),
                ) && (
                  <option value={`${s.closed_window_template}|${s.closed_window_template_language ?? ''}`}>
                    {s.closed_window_template} (no longer usable)
                  </option>
                )}
              {cwTemplates.map((x) => (
                <option key={x.id} value={`${x.name}|${x.language ?? ''}`}>
                  {x.name}
                  {x.language ? ` · ${x.language}` : ''} — {x.body_text.slice(0, 60)}
                </option>
              ))}
            </select>
            {cwTemplates.length === 0 && (
              <span className="block text-xs text-amber-600">
                No approved template has a single {'{{1}}'} yet. Create a Utility template like the example above.
              </span>
            )}
          </div>

          {canEdit ? (
            <div className="flex justify-end border-t border-border pt-4">
              <Button onClick={save} disabled={saving} className="bg-primary text-primary-foreground hover:bg-primary/90">
                {saving && <Loader2 className="size-4 animate-spin" />}
                Save
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Only admins can change these settings.</p>
          )}
        </div>
      )}
      <BusinessHoursPanel />
    </div>
  );
}
