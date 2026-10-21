'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Send, Loader2, Users, Save, CalendarClock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatInZone, zonedLocalToUtcIso } from '@/lib/inbox/timezone';
import { SCHEDULE_TIMEZONES, validateBroadcastSchedule } from '@/lib/campaigns/schedule';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  /** No argument = send now; otherwise schedule for that instant. */
  onSend: (schedule?: { at: string; timezone: string }) => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const tc = useTranslations('Campaigns.schedule');
  const [showConfirm, setShowConfirm] = useState(false);
  const [mode, setMode] = useState<'now' | 'later'>('now');
  const [localTime, setLocalTime] = useState('');
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const scheduledAt = mode === 'later' ? zonedLocalToUtcIso(localTime, timezone) : null;
  // Validated against "now" when the user changes the picker, not on
  // every render (render must stay pure).
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  useEffect(() => {
    setScheduleError(mode === 'later' ? validateBroadcastSchedule(scheduledAt, Date.now()) : null);
  }, [mode, scheduledAt]);
  const templateApproved = (template.status ?? 'APPROVED') === 'APPROVED';
  // Send now needs an approved template; a schedule waits for approval.
  const blocked =
    !name.trim() || isProcessing || (mode === 'now' ? !templateApproved : !!scheduleError);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('scheduleSend.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">{t('scheduleSend.broadcastName')}</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.estimatedReach')}</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.language')}</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* When to send */}
      <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
        <p className="text-sm font-medium text-foreground">{tc('when')}</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={tc('when')}>
          {(['now', 'later'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                mode === m
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              {m === 'now' ? tc('sendNow') : tc('scheduleLater')}
            </button>
          ))}
        </div>
        {mode === 'later' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              {tc('dateTime')}
              <Input
                type="datetime-local"
                value={localTime}
                onChange={(e) => setLocalTime(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              {tc('timezone')}
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground"
              >
                {SCHEDULE_TIMEZONES.map((z) => (
                  <option key={z} value={z}>{z}</option>
                ))}
              </select>
            </label>
            <p className="text-xs text-muted-foreground sm:col-span-2">
              {scheduleError
                ? tc(`errors.${scheduleError}`)
                : scheduledAt
                  ? tc('willSend', { when: formatInZone(scheduledAt, timezone) })
                  : null}
            </p>
            <p className="text-xs text-muted-foreground sm:col-span-2">{tc('frozenNote')}</p>
          </div>
        )}
        {!templateApproved && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {mode === 'now' ? tc('notApprovedNow') : tc('notApprovedLater')}
          </p>
        )}
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">{t('scheduleSend.sending')}</p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
          <DialogTrigger
            render={
              <Button
                disabled={blocked}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              />
            }
          >
            {mode === 'later' ? <CalendarClock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            {mode === 'later' ? tc('scheduleButton') : t('scheduleSend.sendNow')}
          </DialogTrigger>
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {mode === 'later' ? tc('confirmTitle') : t('scheduleSend.confirmTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {mode === 'later' && scheduledAt
                  ? tc('confirmDesc', {
                      count: estimatedReach,
                      template: template.name,
                      when: formatInZone(scheduledAt, timezone),
                    })
                  : t.rich('scheduleSend.confirmDesc', {
                      count: estimatedReach,
                      template: template.name,
                      b: (chunks) => (
                        <span className="font-medium text-popover-foreground">{chunks}</span>
                      ),
                    })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                className="border-border text-muted-foreground"
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={() => {
                  setShowConfirm(false);
                  if (mode === 'later' && scheduledAt) onSend({ at: scheduledAt, timezone });
                  else onSend();
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {mode === 'later' ? <CalendarClock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                {mode === 'later' ? tc('scheduleButton') : t('scheduleSend.sendNow')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>
    </div>
  );
}
