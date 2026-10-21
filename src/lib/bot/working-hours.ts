/**
 * Working Hours Condition + Wait Until — pure time logic shared by Flows
 * and Automations. Schedules live in `business_hours` (migration 047),
 * one per account, edited in Settings → Business hours.
 */

import { zonedToUtc } from './formatters';

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export interface BusinessHours {
  timezone: string;
  /** {"mon": [["09:00","18:00"]], …}; missing/empty day = closed. */
  schedule: Partial<Record<Weekday, [string, string][]>>;
  /** "YYYY-MM-DD" days treated as closed. */
  holidays: string[];
}

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  timezone: 'Asia/Kolkata',
  schedule: {
    mon: [['09:00', '18:00']], tue: [['09:00', '18:00']], wed: [['09:00', '18:00']],
    thu: [['09:00', '18:00']], fri: [['09:00', '18:00']], sat: [['09:00', '18:00']],
  },
  holidays: [],
};

const toMin = (s: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  if (!m || +m[1] > 24 || +m[2] > 59) return null;
  return +m[1] * 60 + +m[2];
};

/** Wall-clock parts of `at` in `tz`. */
export function zonedParts(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: get('weekday').slice(0, 3).toLowerCase() as Weekday,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

export type WorkingHoursResult = 'open' | 'closed' | 'holiday';

export function workingHoursAt(at: Date, hours: BusinessHours): WorkingHoursResult {
  const p = zonedParts(at, hours.timezone || 'Asia/Kolkata');
  if ((hours.holidays ?? []).includes(p.date)) return 'holiday';
  for (const [from, to] of hours.schedule?.[p.weekday] ?? []) {
    const f = toMin(from);
    const t = toMin(to);
    if (f === null || t === null) continue;
    // A window like 22:00–02:00 wraps midnight.
    const inside = f <= t ? p.minutes >= f && p.minutes < t : p.minutes >= f || p.minutes < t;
    if (inside) return 'open';
  }
  return 'closed';
}

/** Validates a schedule before it's saved; returns problems (empty = ok). */
export function validateBusinessHours(h: BusinessHours): string[] {
  const errs: string[] = [];
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: h.timezone });
  } catch {
    errs.push('Unknown time zone');
  }
  for (const day of WEEKDAYS) {
    for (const w of h.schedule?.[day] ?? []) {
      if (toMin(w[0]) === null || toMin(w[1]) === null) errs.push(`${day}: times must be HH:mm`);
      else if (w[0] === w[1]) errs.push(`${day}: start and end are the same`);
    }
  }
  for (const d of h.holidays ?? []) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) errs.push(`Holiday "${d}" must be YYYY-MM-DD`);
  return errs;
}

// ── Wait until ────────────────────────────────────────────────────────

export interface WaitUntilConfig {
  /** "YYYY-MM-DDTHH:mm" wall time, or an ISO instant with offset. */
  at: string;
  timezone?: string;
  /** Run this many minutes BEFORE `at` (e.g. 60 = one hour before). */
  offset_minutes?: number;
  /** What to do when the time has already passed. */
  if_past?: 'run_now' | 'skip';
  /** 'weekly': the next upcoming occurrence of that weekday and time. */
  repeat?: 'none' | 'weekly';
}

export type WaitUntilPlan =
  | { ok: true; runAt: Date; past: boolean }
  | { ok: false; error: string };

/** When a Wait Until step should resume. Stored UTC; zone is explicit. */
export function planWaitUntil(cfg: WaitUntilConfig, now: Date): WaitUntilPlan {
  const tz = cfg.timezone || 'Asia/Kolkata';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return { ok: false, error: 'Unknown time zone' };
  }
  const v = (cfg.at ?? '').trim();
  let ms: number;
  const wall = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(v);
  if (wall) {
    const [, y, mo, d, h, mi] = wall;
    ms = zonedToUtc(+y, +mo, +d, +(h ?? 0), +(mi ?? 0), 0, tz);
    const check = new Date(Date.UTC(+y, +mo - 1, +d));
    if (check.getUTCMonth() !== +mo - 1 || +(h ?? 0) > 23 || +(mi ?? 0) > 59) return { ok: false, error: `Not a valid date/time: "${v}"` };
  } else if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) {
    ms = Date.parse(v);
  } else {
    return { ok: false, error: `Not a valid date/time: "${v.slice(0, 40)}"` };
  }
  if (!Number.isFinite(ms)) return { ok: false, error: `Not a valid date/time: "${v.slice(0, 40)}"` };
  const offset = Math.max(0, Math.min(Number(cfg.offset_minutes ?? 0) || 0, 60 * 24 * 365));
  let runAt = new Date(ms - offset * 60_000);
  if (cfg.repeat === 'weekly') {
    // Same weekday and wall time every week: move forward to the next
    // occurrence (never "past"). 7-day steps keep the local time except
    // across a DST change, which IST and most target zones don't have.
    const WEEK = 7 * 86_400_000;
    if (runAt.getTime() <= now.getTime()) {
      const weeks = Math.floor((now.getTime() - runAt.getTime()) / WEEK) + 1;
      runAt = new Date(runAt.getTime() + weeks * WEEK);
    }
  }
  return { ok: true, runAt, past: runAt.getTime() <= now.getTime() };
}
