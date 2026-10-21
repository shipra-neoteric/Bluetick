'use client';

import { Fragment } from 'react';
import { ExternalLink, Phone, Copy, Workflow, Reply, Image as ImageIcon, FileText, Video } from 'lucide-react';
import type { TemplateButton } from '@/types';

export interface PreviewTemplate {
  header_type?: string | null;
  header_content?: string | null;
  header_media_url?: string | null;
  body_text: string;
  footer_text?: string | null;
  buttons?: TemplateButton[] | null;
}

/**
 * WhatsApp-style message bubble for a template. `{{n}}` placeholders
 * render as chips showing `labels[n]` (a sample value or the bound
 * custom-field name) so users can see what each variable will become.
 */
export function TemplatePhonePreview({
  template,
  labels = {},
  compact = false,
}: {
  template: PreviewTemplate;
  labels?: Record<string, string>;
  compact?: boolean;
}) {
  const headerType = (template.header_type ?? '').toLowerCase();
  const buttons = template.buttons ?? [];

  return (
    <div
      className={`rounded-2xl bg-[#e5ddd5] p-3 dark:bg-[#0b141a] ${compact ? '' : 'min-h-[280px]'}`}
      aria-label="Template preview"
    >
      <div className="max-w-[300px] overflow-hidden rounded-lg rounded-tl-none bg-white text-[13px] text-[#111b21] shadow-sm dark:bg-[#202c33] dark:text-[#e9edef]">
        {headerType && headerType !== 'text' && (
          <div className="flex h-28 items-center justify-center bg-black/5 text-black/40 dark:bg-white/5 dark:text-white/40">
            {template.header_media_url && headerType === 'image' ? (
              // eslint-disable-next-line @next/next/no-img-element -- arbitrary user URL preview
              <img src={template.header_media_url} alt="" className="h-full w-full object-cover" />
            ) : headerType === 'video' ? (
              <Video className="h-8 w-8" />
            ) : headerType === 'document' ? (
              <FileText className="h-8 w-8" />
            ) : (
              <ImageIcon className="h-8 w-8" />
            )}
          </div>
        )}
        <div className="space-y-1 px-2.5 pb-1.5 pt-2">
          {headerType === 'text' && template.header_content && (
            <p className="font-semibold">
              <WithVariables text={template.header_content} labels={labels} />
            </p>
          )}
          <p className="whitespace-pre-wrap break-words">
            <WithVariables text={template.body_text || ' '} labels={labels} />
          </p>
          {template.footer_text && (
            <p className="text-[11px] text-black/45 dark:text-white/45">{template.footer_text}</p>
          )}
        </div>
        {buttons.length > 0 && (
          <div className="divide-y divide-black/10 border-t border-black/10 dark:divide-white/10 dark:border-white/10">
            {buttons.map((b, i) => (
              <div
                key={i}
                className="flex items-center justify-center gap-1.5 py-2 text-[13px] font-medium text-[#00a5f4]"
              >
                <ButtonIcon button={b} />
                {b.text || '…'}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ButtonIcon({ button }: { button: TemplateButton }) {
  const cls = 'h-3.5 w-3.5';
  switch (button.type) {
    case 'URL':
      return <ExternalLink className={cls} />;
    case 'PHONE_NUMBER':
      return <Phone className={cls} />;
    case 'COPY_CODE':
      return <Copy className={cls} />;
    case 'FLOW':
      return <Workflow className={cls} />;
    default:
      return <Reply className={cls} />;
  }
}

function WithVariables({ text, labels }: { text: string; labels: Record<string, string> }) {
  const parts = text.split(/(\{\{\s*\d+\s*\}\})/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\{\{\s*(\d+)\s*\}\}$/.exec(part);
        if (!m) return <Fragment key={i}>{part}</Fragment>;
        const label = labels[m[1]];
        return (
          <span
            key={i}
            className="rounded bg-emerald-500/15 px-1 text-emerald-700 dark:text-emerald-300"
          >
            {label ? label : `{{${m[1]}}}`}
          </span>
        );
      })}
    </>
  );
}
