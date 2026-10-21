/**
 * Format Date / Format Mobile Number — shared by the Flow `format_value`
 * node and the Automation `format_date` / `format_phone` steps. Pure: no
 * DB, no network. Results go into a variable; the source value (contact
 * field, captured answer, trigger payload) is never modified.
 */

import { toInternationalPhone } from '@/lib/whatsapp/phone-utils';

export type Formatted = { ok: true; value: string } | { ok: false; error: string };

// ── Dates ─────────────────────────────────────────────────────────────

export type DateInputFormat = 'auto' | 'iso' | 'dmy' | 'mdy' | 'ymd' | 'epoch_ms' | 'epoch_s';

export interface FormatDateOptions {
  inputFormat?: DateInputFormat;
  /** Zone a date-time WITHOUT an explicit offset was written in. */
  inputTimezone?: string;
  /** Tokens: YYYY YY MMMM MMM MM M DD D dddd ddd HH H hh h mm ss A */
  outputFormat: string;
  outputTimezone?: string;
}

interface Parsed {
  /** UTC instant, or the calendar date at 00:00Z for date-only input. */
  ms: number;
  dateOnly: boolean;
}

function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock fields in `tz` → UTC ms (two passes for DST edges). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = guess - zoneOffsetMs(guess, tz);
  utc = guess - zoneOffsetMs(utc, tz);
  return utc;
}

function validCalendar(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function parseDateInput(raw: string, fmt: DateInputFormat = 'auto', tz = 'Asia/Kolkata'): Parsed | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  if (fmt === 'epoch_ms' || fmt === 'epoch_s' || (fmt === 'auto' && /^\d{10,13}$/.test(v))) {
    if (!/^\d+$/.test(v)) return null;
    const n = Number(v);
    const ms = fmt === 'epoch_s' || (fmt === 'auto' && v.length === 10) ? n * 1000 : n;
    return Number.isFinite(ms) ? { ms, dateOnly: false } : null;
  }
  // YYYY-MM-DD[THH:mm[:ss][.sss][Z|±HH:mm]]
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/.exec(v);
  if (iso && (fmt === 'auto' || fmt === 'iso' || fmt === 'ymd')) {
    const [, y, mo, d, h, mi, s, off] = iso;
    if (!validCalendar(+y, +mo, +d)) return null;
    if (h === undefined) return { ms: Date.UTC(+y, +mo - 1, +d), dateOnly: true };
    if (+h > 23 || +mi > 59 || +(s ?? 0) > 59) return null;
    if (off) {
      const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}${off.length === 5 ? `${off.slice(0, 3)}:${off.slice(3)}` : off}`);
      return Number.isFinite(ms) ? { ms, dateOnly: false } : null;
    }
    return { ms: zonedToUtc(+y, +mo, +d, +h, +mi, +(s ?? 0), tz), dateOnly: false };
  }
  // DD/MM/YYYY or MM/DD/YYYY (also - or .), optional HH:mm
  const dm = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(v);
  if (dm && fmt !== 'iso' && fmt !== 'ymd') {
    const [, a, b, y, h, mi] = dm;
    // 'auto' reads slashes as day-first (India); pick 'mdy' for US data.
    const [d, mo] = fmt === 'mdy' ? [+b, +a] : [+a, +b];
    if (!validCalendar(+y, mo, d)) return null;
    if (h === undefined) return { ms: Date.UTC(+y, mo - 1, d), dateOnly: true };
    if (+h > 23 || +mi > 59) return null;
    return { ms: zonedToUtc(+y, mo, d, +h, +mi, 0, tz), dateOnly: false };
  }
  return null;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function formatDate(raw: string, opts: FormatDateOptions): Formatted {
  const inTz = opts.inputTimezone || 'Asia/Kolkata';
  const outTz = opts.outputTimezone || inTz;
  if (!isValidZone(inTz) || !isValidZone(outTz)) return { ok: false, error: 'Unknown time zone' };
  if (!opts.outputFormat?.trim()) return { ok: false, error: 'Output format is required' };
  const parsed = parseDateInput(raw, opts.inputFormat ?? 'auto', inTz);
  if (!parsed) return { ok: false, error: `Not a valid date: "${String(raw ?? '').slice(0, 40)}"` };

  // A date-only value is a calendar date — never shift it across zones.
  const local = parsed.dateOnly ? parsed.ms : parsed.ms + zoneOffsetMs(parsed.ms, outTz);
  const dt = new Date(local);
  const Y = dt.getUTCFullYear();
  const M = dt.getUTCMonth();
  const D = dt.getUTCDate();
  const H = dt.getUTCHours();
  const m = dt.getUTCMinutes();
  const s = dt.getUTCSeconds();
  const pad = (n: number) => String(n).padStart(2, '0');
  const h12 = H % 12 === 0 ? 12 : H % 12;
  const tokens: Record<string, string> = {
    YYYY: String(Y), YY: String(Y).slice(-2), MMMM: MONTHS[M], MMM: MONTHS[M].slice(0, 3), MM: pad(M + 1), M: String(M + 1),
    DD: pad(D), D: String(D), dddd: DAYS[dt.getUTCDay()], ddd: DAYS[dt.getUTCDay()].slice(0, 3),
    HH: pad(H), H: String(H), hh: pad(h12), h: String(h12), mm: pad(m), ss: pad(s), A: H < 12 ? 'AM' : 'PM',
  };
  const value = opts.outputFormat.replace(/YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|hh|h|mm|ss|A/g, (t) => tokens[t]);
  return { ok: true, value };
}

// ── Phone numbers ─────────────────────────────────────────────────────

export type PhoneOutput = 'e164' | 'digits' | 'national';

/**
 * Normalise a phone number. A number written with its own country code
 * (+ or 00) keeps it; `defaultCountryCode` is applied only to national
 * numbers. Nothing is ever prepended implicitly.
 */
export function formatPhone(raw: string, opts: { defaultCountryCode?: string; output?: PhoneOutput }): Formatted {
  const cc = (opts.defaultCountryCode ?? '').replace(/\D/g, '');
  const e164 = toInternationalPhone(raw, cc || null);
  if (!e164) {
    return {
      ok: false,
      error: cc
        ? `Not a valid phone number: "${String(raw ?? '').slice(0, 40)}"`
        : 'Number has no country code and no default country was set',
    };
  }
  const digits = e164.slice(1);
  switch (opts.output ?? 'e164') {
    case 'digits':
      return { ok: true, value: digits };
    case 'national':
      if (!cc || !digits.startsWith(cc)) return { ok: false, error: 'National format needs a matching default country code' };
      return { ok: true, value: digits.slice(cc.length) };
    default:
      return { ok: true, value: e164 };
  }
}
