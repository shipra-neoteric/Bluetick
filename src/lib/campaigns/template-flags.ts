import type { TemplateButton } from '@/types';

/**
 * `opt_out` on a quick reply is a Bluetick-only flag — Meta never returns it.
 * A template sync replaces buttons with Meta's copy, so carry the flag
 * over by label from the row being overwritten.
 */
export function preserveOptOutFlags(
  fresh: TemplateButton[] | null,
  previous: TemplateButton[] | null | undefined,
): TemplateButton[] | null {
  if (!fresh || !previous?.length) return fresh;
  const flagged = new Set(
    previous
      .filter((b) => b.type === 'QUICK_REPLY' && b.opt_out)
      .map((b) => b.text.trim().toLowerCase()),
  );
  if (!flagged.size) return fresh;
  return fresh.map((b) =>
    b.type === 'QUICK_REPLY' && flagged.has(b.text.trim().toLowerCase())
      ? { ...b, opt_out: true }
      : b,
  );
}
