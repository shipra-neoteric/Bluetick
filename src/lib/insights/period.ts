/**
 * Insights periods. Every period is
 * a half-open UTC interval [from, to) computed from local days in an
 * explicit IANA timezone. Browser-safe.
 */

import { zonedToUtc } from "@/lib/bot/formatters";
import { zonedParts } from "@/lib/bot/working-hours";

export const PRESETS = ["today", "yesterday", "last_7_days", "last_30_days", "custom"] as const;
export type Preset = (typeof PRESETS)[number];
export const MAX_RANGE_DAYS = 92;

export interface Period {
  from: Date;
  to: Date;
  tz: string;
  bucket: "hour" | "day";
  /** Local day keys covered (YYYY-MM-DD), in order. */
  days: string[];
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const parseDay = (d: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
};
const addDays = (key: string, n: number) => {
  const p = parseDay(key)!;
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d + n));
  return t.toISOString().slice(0, 10);
};
const startOfDay = (key: string, tz: string) => {
  const p = parseDay(key)!;
  return new Date(zonedToUtc(p.y, p.mo, p.d, 0, 0, 0, tz));
};

/** Resolve a preset (or custom from/to local days) to a period. */
export function resolvePeriod(
  input: { preset: Preset; from?: string; to?: string; tz: string },
  now: Date = new Date(),
): { ok: true; period: Period } | { ok: false; error: string } {
  const { tz } = input;
  if (!isValidTimeZone(tz)) return { ok: false, error: "Unknown time zone." };
  const today = zonedParts(now, tz).date;
  let first: string;
  let last: string;
  switch (input.preset) {
    case "today":
      first = last = today;
      break;
    case "yesterday":
      first = last = addDays(today, -1);
      break;
    case "last_7_days":
      first = addDays(today, -6);
      last = today;
      break;
    case "last_30_days":
      first = addDays(today, -29);
      last = today;
      break;
    case "custom": {
      if (!input.from || !input.to || !parseDay(input.from) || !parseDay(input.to)) return { ok: false, error: "Pick a start and an end date." };
      if (input.from > input.to) return { ok: false, error: "The start date is after the end date." };
      if (input.from > today) return { ok: false, error: "The period can't start in the future." };
      first = input.from;
      last = input.to;
      break;
    }
    default:
      return { ok: false, error: "Unknown period." };
  }
  const days: string[] = [];
  for (let k = first; k <= last; k = addDays(k, 1)) {
    days.push(k);
    if (days.length > MAX_RANGE_DAYS) return { ok: false, error: `Choose ${MAX_RANGE_DAYS} days or fewer.` };
  }
  return {
    ok: true,
    period: { from: startOfDay(first, tz), to: startOfDay(addDays(last, 1), tz), tz, bucket: days.length === 1 ? "hour" : "day", days },
  };
}

/** Every bucket key the SQL can return for this period, in order. */
export function bucketKeys(p: Period): string[] {
  if (p.bucket === "day") return p.days;
  return Array.from({ length: 24 }, (_, h) => `${p.days[0]}T${String(h).padStart(2, "0")}:00`);
}
