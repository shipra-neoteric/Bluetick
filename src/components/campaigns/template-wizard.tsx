'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Check, Loader2, Plus, Trash2, Upload, Lock } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { isMissingSchemaError } from '@/lib/db/schema-compat';
import { uploadAccountMedia, MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media';
import { MEDIA_HEADER_SPECS, type MediaHeaderKind } from '@/lib/whatsapp/media-header-types';
import {
  TEMPLATE_LIMITS,
  extractVariableIndices,
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators';
import {
  insertVariable,
  missingVariableIndices,
  nextVariableIndex,
  pruneBindings,
  variableLabels,
} from '@/lib/campaigns/template-library';
import type { MessageTemplate, TemplateButton, TemplateVariableBinding } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TemplatePhonePreview } from './template-phone-preview';

type HeaderFormat = 'none' | 'text' | 'image' | 'video' | 'document';
const STEPS = ['basic', 'content', 'buttons', 'variables'] as const;
type Step = (typeof STEPS)[number];

const LANGUAGES = ['en', 'en_US', 'en_GB', 'hi', 'mr', 'gu', 'ta', 'te', 'kn', 'bn', 'pa', 'ml', 'es', 'pt_BR', 'ar'];
const BUILT_IN_FIELDS = ['name', 'phone', 'email', 'company'] as const;

/** Button kinds offered. `optout` is a quick reply flagged opt_out. */
type ButtonKind = 'QUICK_REPLY' | 'optout' | 'URL' | 'PHONE_NUMBER' | 'COPY_CODE' | 'FLOW';
const BUTTON_KINDS: ButtonKind[] = ['QUICK_REPLY', 'optout', 'URL', 'PHONE_NUMBER', 'COPY_CODE', 'FLOW'];
/** Shown but not offered: not verified against Meta's template API. */
const UNAVAILABLE_KINDS = ['callOnWhatsapp', 'shareContact', 'carousel'] as const;

function newButton(kind: ButtonKind): TemplateButton {
  switch (kind) {
    case 'optout':
      return { type: 'QUICK_REPLY', text: 'Stop promotions', opt_out: true };
    case 'URL':
      return { type: 'URL', text: '', url: '' };
    case 'PHONE_NUMBER':
      return { type: 'PHONE_NUMBER', text: '', phone_number: '' };
    case 'COPY_CODE':
      return { type: 'COPY_CODE', text: 'Copy code', example: '' };
    case 'FLOW':
      return { type: 'FLOW', text: '', flow_id: '' };
    default:
      return { type: 'QUICK_REPLY', text: '' };
  }
}

/** Quick replies must come first (Meta rule) — keep them grouped. */
function orderButtons(buttons: TemplateButton[]): TemplateButton[] {
  return [...buttons.filter((b) => b.type === 'QUICK_REPLY'), ...buttons.filter((b) => b.type !== 'QUICK_REPLY')];
}

interface Draft {
  name: string;
  category: MessageTemplate['category'];
  language: string;
  header: HeaderFormat;
  headerText: string;
  headerMediaUrl: string;
  headerSample: string;
  body: string;
  footer: string;
  buttons: TemplateButton[];
  samples: string[];
  bindings: Record<string, TemplateVariableBinding>;
}

function draftFrom(t?: MessageTemplate | null): Draft {
  return {
    name: t?.name ?? '',
    category: t?.category ?? 'Marketing',
    language: t?.language ?? 'en',
    header: (t?.header_type ?? 'none') as HeaderFormat,
    headerText: t?.header_content ?? '',
    headerMediaUrl: t?.header_media_url ?? '',
    headerSample: t?.sample_values?.header?.[0] ?? '',
    body: t?.body_text ?? '',
    footer: t?.footer_text ?? '',
    buttons: t?.buttons ?? [],
    samples: t?.sample_values?.body ?? [],
    bindings: t?.variable_bindings ?? {},
  };
}

export function toTemplatePayload(d: Draft): TemplatePayload {
  const bodyCount = extractVariableIndices(d.body).length;
  const samples = d.samples.slice(0, bodyCount).map((s) => s.trim());
  const sample_values: TemplatePayload['sample_values'] = {};
  if (samples.some(Boolean)) sample_values.body = samples;
  if (d.header === 'text' && d.headerSample.trim()) sample_values.header = [d.headerSample.trim()];
  return {
    name: d.name.trim(),
    category: d.category,
    language: d.language.trim() || 'en',
    header_type: d.header === 'none' ? undefined : d.header,
    header_content: d.header === 'text' ? d.headerText.trim() : undefined,
    header_media_url: d.header !== 'none' && d.header !== 'text' ? d.headerMediaUrl.trim() || undefined : undefined,
    body_text: d.body.trim(),
    footer_text: d.footer.trim() || undefined,
    buttons: d.buttons.length ? orderButtons(d.buttons) : undefined,
    sample_values: Object.keys(sample_values).length ? sample_values : undefined,
  };
}

/**
 * Basic Info → Content → Buttons → Variables, with a live WhatsApp
 * preview. Submits through the same routes as the classic builder in
 * Settings (POST /submit, PATCH /[id] for edits), then stores the
 * variable bindings (migration 046; skipped when not applied).
 */
export function TemplateWizard({
  open,
  onOpenChange,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: MessageTemplate | null;
  onSaved: () => void;
}) {
  const t = useTranslations('Campaigns.wizard');
  const [step, setStep] = useState<Step>('basic');
  const [d, setD] = useState<Draft>(() => draftFrom(editing));
  const [customFields, setCustomFields] = useState<{ id: string; field_name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setD(draftFrom(editing));
    setStep('basic');
  }, [open, editing]);

  useEffect(() => {
    if (!open) return;
    const supabase = createClient();
    void supabase
      .from('custom_fields')
      .select('id, field_name, archived_at')
      .order('field_name')
      .then(async ({ data, error }) => {
        let rows = data as { id: string; field_name: string; archived_at?: string | null }[] | null;
        if (error && isMissingSchemaError(error)) {
          // Pre-044: no archived_at column.
          const res = await supabase.from('custom_fields').select('id, field_name').order('field_name');
          rows = res.data as typeof rows;
        }
        setCustomFields((rows ?? []).filter((r) => !r.archived_at));
      });
  }, [open]);

  const set = (patch: Partial<Draft>) => setD((prev) => ({ ...prev, ...patch }));
  const bodyVars = useMemo(() => [...new Set(extractVariableIndices(d.body))].sort((a, b) => a - b), [d.body]);
  const gaps = useMemo(() => missingVariableIndices(d.body), [d.body]);

  const fieldLabel = (b: TemplateVariableBinding) =>
    b.type === 'custom_field'
      ? b.label ?? customFields.find((f) => f.id === b.value)?.field_name ?? t('customField')
      : b.type === 'field'
        ? t(`fields.${b.value}`)
        : b.value;
  const labels = variableLabels(d.samples, d.bindings, fieldLabel);

  let validationError: string | null = null;
  try {
    validateTemplatePayload(toTemplatePayload(d));
    if (gaps.length) validationError = t('errors.gaps', { list: gaps.map((g) => `{{${g}}}`).join(', ') });
  } catch (err) {
    validationError = err instanceof Error ? err.message : String(err);
  }

  const stepValid: Record<Step, boolean> = {
    basic: TEMPLATE_LIMITS.nameRegex.test(d.name.trim()) && d.category !== 'Authentication',
    content: !!d.body.trim() && d.body.length <= TEMPLATE_LIMITS.bodyMaxLength && !gaps.length,
    buttons: true,
    variables: !validationError,
  };

  function addVariable(binding: TemplateVariableBinding) {
    const index = nextVariableIndex(d.body, d.header === 'text' ? d.headerText : '');
    const el = bodyRef.current;
    const { text, caret } = insertVariable(d.body, index, el?.selectionStart ?? d.body.length);
    set({ body: text, bindings: { ...d.bindings, [String(index)]: binding } });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  function onBodyChange(body: string) {
    set({ body, bindings: pruneBindings(d.bindings, body) });
  }

  function updateButton(i: number, patch: Partial<TemplateButton>) {
    set({ buttons: d.buttons.map((b, j) => (j === i ? ({ ...b, ...patch } as TemplateButton) : b)) });
  }

  async function onHeaderFile(file: File) {
    const kind = d.header as MediaHeaderKind;
    if (!MEDIA_HEADER_SPECS[kind]?.mimeTypes.includes(file.type)) {
      toast.error(t('errors.fileType', { formats: MEDIA_HEADER_SPECS[kind]?.formats ?? '' }));
      return;
    }
    if (file.size > MEDIA_MAX_BYTES_BY_KIND[kind]) {
      toast.error(t('errors.fileSize', { max: Math.round(MEDIA_MAX_BYTES_BY_KIND[kind] / 1024 / 1024) }));
      return;
    }
    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia('chat-media', file);
      set({ headerMediaUrl: publicUrl });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('errors.upload'));
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    if (validationError) return;
    setSubmitting(true);
    try {
      const payload = toTemplatePayload(d);
      const res = await fetch(editing ? `/api/whatsapp/templates/${editing.id}` : '/api/whatsapp/templates/submit', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || t('errors.submitHttp', { status: res.status }));

      // Bindings are Bluetick-only (Meta never sees them).
      const bindings = pruneBindings(d.bindings, d.body);
      const supabase = createClient();
      const { error } = await supabase
        .from('message_templates')
        .update({ variable_bindings: bindings })
        .eq('name', payload.name)
        .eq('language', payload.language);
      if (error && !isMissingSchemaError(error)) console.error('[template-wizard] bindings save failed:', error.message);

      toast.success(data?.dry_run ? t('savedDryRun') : editing ? t('resubmitted') : t('submitted'));
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('errors.submit'));
    } finally {
      setSubmitting(false);
    }
  }

  const idx = STEPS.indexOf(step);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto border-border bg-popover sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{editing ? t('editTitle', { name: editing.name }) : t('title')}</DialogTitle>
          <DialogDescription>{t('subtitle')}</DialogDescription>
        </DialogHeader>

        <ol className="flex flex-wrap gap-2 text-xs">
          {STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => i <= idx && setStep(s)}
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1 ${
                  s === step
                    ? 'border-primary bg-primary/10 text-primary'
                    : i < idx
                      ? 'border-primary/40 text-primary'
                      : 'border-border text-muted-foreground'
                }`}
              >
                {i < idx ? <Check className="h-3 w-3" /> : <span>{i + 1}</span>}
                {t(`steps.${s}`)}
              </button>
            </li>
          ))}
        </ol>

        <div className="grid gap-6 md:grid-cols-[1fr_320px]">
          <div className="min-w-0 space-y-4">
            {step === 'basic' && (
              <>
                <Field label={t('name')} hint={t('nameHint')}>
                  <Input
                    value={d.name}
                    disabled={!!editing}
                    onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
                    placeholder="site_visit_followup"
                  />
                </Field>
                <Field label={t('category')}>
                  <div className="flex flex-wrap gap-2">
                    {(['Marketing', 'Utility', 'Authentication'] as const).map((c) => (
                      <button
                        key={c}
                        type="button"
                        disabled={c === 'Authentication' || !!editing}
                        onClick={() => set({ category: c })}
                        className={`rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50 ${
                          d.category === c ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'
                        }`}
                      >
                        {t(`categories.${c}`)}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{t('authNote')}</p>
                </Field>
                <Field label={t('language')}>
                  <select
                    value={d.language}
                    disabled={!!editing}
                    onChange={(e) => set({ language: e.target.value })}
                    className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm"
                  >
                    {[...new Set([d.language, ...LANGUAGES])].map((l) => (
                      <option key={l} value={l}>{l}</option>
                    ))}
                  </select>
                </Field>
              </>
            )}

            {step === 'content' && (
              <>
                <Field label={t('header')}>
                  <div className="flex flex-wrap gap-2">
                    {(['none', 'text', 'image', 'video', 'document'] as const).map((h) => (
                      <button
                        key={h}
                        type="button"
                        onClick={() => set({ header: h })}
                        className={`rounded-lg border px-3 py-1.5 text-sm ${
                          d.header === h ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'
                        }`}
                      >
                        {t(`headers.${h}`)}
                      </button>
                    ))}
                  </div>
                  {d.header === 'text' && (
                    <Input
                      className="mt-2"
                      maxLength={TEMPLATE_LIMITS.headerTextMaxLength}
                      value={d.headerText}
                      onChange={(e) => set({ headerText: e.target.value })}
                      placeholder={t('headerTextPlaceholder')}
                    />
                  )}
                  {d.header !== 'none' && d.header !== 'text' && (
                    <div className="mt-2 flex gap-2">
                      <Input
                        value={d.headerMediaUrl}
                        onChange={(e) => set({ headerMediaUrl: e.target.value })}
                        placeholder="https://…"
                      />
                      <input
                        ref={fileRef}
                        type="file"
                        hidden
                        accept={MEDIA_HEADER_SPECS[d.header as MediaHeaderKind].mimeTypes.join(',')}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void onHeaderFile(f);
                          e.target.value = '';
                        }}
                      />
                      <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading}>
                        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                        {t('upload')}
                      </Button>
                    </div>
                  )}
                </Field>

                <Field
                  label={t('body')}
                  hint={`${d.body.length}/${TEMPLATE_LIMITS.bodyMaxLength}`}
                >
                  <Textarea
                    ref={bodyRef}
                    rows={7}
                    maxLength={TEMPLATE_LIMITS.bodyMaxLength}
                    value={d.body}
                    onChange={(e) => onBodyChange(e.target.value)}
                    placeholder={t('bodyPlaceholder')}
                  />
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-muted-foreground">{t('insertVariable')}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {BUILT_IN_FIELDS.map((f) => (
                        <Chip key={f} onClick={() => addVariable({ type: 'field', value: f })}>
                          {t(`fields.${f}`)}
                        </Chip>
                      ))}
                      {customFields.map((f) => (
                        <Chip
                          key={f.id}
                          onClick={() => addVariable({ type: 'custom_field', value: f.id, label: f.field_name })}
                        >
                          {f.field_name}
                        </Chip>
                      ))}
                      <Chip onClick={() => addVariable({ type: 'static', value: '' })}>{t('plainVariable')}</Chip>
                    </div>
                  </div>
                  {gaps.length > 0 && (
                    <p className="mt-1 text-xs text-red-500">
                      {t('errors.gaps', { list: gaps.map((g) => `{{${g}}}`).join(', ') })}
                    </p>
                  )}
                </Field>

                <Field label={t('footer')} hint={`${d.footer.length}/${TEMPLATE_LIMITS.footerMaxLength}`}>
                  <Input
                    maxLength={TEMPLATE_LIMITS.footerMaxLength}
                    value={d.footer}
                    onChange={(e) => set({ footer: e.target.value })}
                    placeholder={t('footerPlaceholder')}
                  />
                </Field>
              </>
            )}

            {step === 'buttons' && (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {BUTTON_KINDS.map((k) => (
                    <Chip
                      key={k}
                      disabled={d.buttons.length >= TEMPLATE_LIMITS.maxButtonsTotal ||
                        (k === 'optout' && d.buttons.some((b) => b.type === 'QUICK_REPLY' && b.opt_out))}
                      onClick={() => set({ buttons: orderButtons([...d.buttons, newButton(k)]) })}
                    >
                      <Plus className="h-3 w-3" />
                      {t(`buttonKinds.${k}`)}
                    </Chip>
                  ))}
                  {UNAVAILABLE_KINDS.map((k) => (
                    <span
                      key={k}
                      title={t('unavailableHint')}
                      className="inline-flex cursor-not-allowed items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground opacity-60"
                    >
                      <Lock className="h-3 w-3" />
                      {t(`buttonKinds.${k}`)}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{t('buttonsNote')}</p>

                <div className="space-y-3">
                  {d.buttons.map((b, i) => (
                    <div key={i} className="space-y-2 rounded-lg border border-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-muted-foreground">
                          {t(`buttonKinds.${b.type === 'QUICK_REPLY' && b.opt_out ? 'optout' : b.type}`)}
                        </span>
                        <button
                          type="button"
                          aria-label={t('removeButton')}
                          onClick={() => set({ buttons: d.buttons.filter((_, j) => j !== i) })}
                          className="text-muted-foreground hover:text-red-500"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      <Input
                        maxLength={TEMPLATE_LIMITS.buttonTextMaxLength}
                        value={b.text}
                        onChange={(e) => updateButton(i, { text: e.target.value })}
                        placeholder={t('buttonText')}
                      />
                      {b.type === 'URL' && (
                        <>
                          <Input value={b.url} onChange={(e) => updateButton(i, { url: e.target.value })} placeholder="https://example.com/{{1}}" />
                          {extractVariableIndices(b.url).length > 0 && (
                            <Input value={b.example ?? ''} onChange={(e) => updateButton(i, { example: e.target.value })} placeholder={t('urlExample')} />
                          )}
                        </>
                      )}
                      {b.type === 'PHONE_NUMBER' && (
                        <Input value={b.phone_number} onChange={(e) => updateButton(i, { phone_number: e.target.value })} placeholder="+919876543210" />
                      )}
                      {b.type === 'COPY_CODE' && (
                        <Input value={b.example} maxLength={20} onChange={(e) => updateButton(i, { example: e.target.value })} placeholder={t('couponExample')} />
                      )}
                      {b.type === 'FLOW' && (
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Input value={b.flow_id} onChange={(e) => updateButton(i, { flow_id: e.target.value.replace(/\D/g, '') })} placeholder={t('flowId')} />
                          <Input value={b.navigate_screen ?? ''} onChange={(e) => updateButton(i, { navigate_screen: e.target.value })} placeholder={t('flowScreen')} />
                        </div>
                      )}
                      {b.type === 'QUICK_REPLY' && b.opt_out && (
                        <p className="text-xs text-muted-foreground">{t('optOutExplain')}</p>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}

            {step === 'variables' && (
              <>
                {bodyVars.length === 0 && d.header !== 'text' ? (
                  <p className="text-sm text-muted-foreground">{t('noVariables')}</p>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-muted-foreground">{t('samplesNote')}</p>
                    {d.header === 'text' && extractVariableIndices(d.headerText).length > 0 && (
                      <Field label={t('headerSample')}>
                        <Input value={d.headerSample} onChange={(e) => set({ headerSample: e.target.value })} />
                      </Field>
                    )}
                    {bodyVars.map((n) => {
                      const b = d.bindings[String(n)];
                      return (
                        <div key={n} className="grid items-center gap-2 sm:grid-cols-[60px_1fr_1fr]">
                          <code className="text-sm text-primary">{`{{${n}}}`}</code>
                          <select
                            value={b ? `${b.type}:${b.value}` : 'static:'}
                            onChange={(e) => {
                              const [type, ...rest] = e.target.value.split(':');
                              const value = rest.join(':');
                              const next: TemplateVariableBinding =
                                type === 'field'
                                  ? { type: 'field', value }
                                  : type === 'custom_field'
                                    ? { type: 'custom_field', value, label: customFields.find((f) => f.id === value)?.field_name }
                                    : { type: 'static', value: '' };
                              set({ bindings: { ...d.bindings, [String(n)]: next } });
                            }}
                            className="h-9 rounded-md border border-border bg-muted px-2 text-sm"
                          >
                            <option value="static:">{t('boundNone')}</option>
                            {BUILT_IN_FIELDS.map((f) => (
                              <option key={f} value={`field:${f}`}>{t(`fields.${f}`)}</option>
                            ))}
                            {customFields.map((f) => (
                              <option key={f.id} value={`custom_field:${f.id}`}>{f.field_name}</option>
                            ))}
                          </select>
                          <Input
                            value={d.samples[n - 1] ?? ''}
                            onChange={(e) => {
                              const samples = [...d.samples];
                              while (samples.length < n) samples.push('');
                              samples[n - 1] = e.target.value;
                              set({ samples });
                            }}
                            placeholder={t('sampleValue')}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
                {validationError && <p className="text-sm text-red-500">{validationError}</p>}
              </>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">{t('preview')}</p>
            <TemplatePhonePreview
              template={{
                header_type: d.header === 'none' ? null : d.header,
                header_content: d.headerText,
                header_media_url: d.headerMediaUrl,
                body_text: d.body,
                footer_text: d.footer,
                buttons: orderButtons(d.buttons),
              }}
              labels={labels}
            />
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-border pt-4">
          <Button variant="outline" onClick={() => (idx === 0 ? onOpenChange(false) : setStep(STEPS[idx - 1]))}>
            <ArrowLeft className="h-4 w-4" />
            {idx === 0 ? t('cancel') : t('back')}
          </Button>
          {idx < STEPS.length - 1 ? (
            <Button onClick={() => setStep(STEPS[idx + 1])} disabled={!stepValid[step]}>
              {t('next')}
              <ArrowRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={() => void submit()} disabled={!!validationError || submitting}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing ? t('resubmit') : t('submit')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <label className="text-sm font-medium text-foreground">{label}</label>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Chip({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-foreground hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}
