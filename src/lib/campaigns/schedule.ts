/**
 * Broadcast scheduling rules shared by the wizard (and any future API).
 * Times are stored in UTC; the zone is kept for display only.
 */

/** Zones offered in the picker. Asia/Kolkata first (account default). */
export const SCHEDULE_TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'UTC',
] as const;

/** At least 2 minutes ahead, so the 1-minute worker tick can't miss it. */
export const MIN_SCHEDULE_LEAD_MS = 2 * 60_000;
/** Up to 90 days ahead (same as scheduled inbox messages). */
export const MAX_SCHEDULE_LEAD_MS = 90 * 24 * 3600_000;

export type ScheduleError = 'missing' | 'tooSoon' | 'tooFar';

/** Null when `isoUtc` is an acceptable send time; otherwise why not. */
export function validateBroadcastSchedule(
  isoUtc: string | null | undefined,
  now: number,
): ScheduleError | null {
  const at = isoUtc ? Date.parse(isoUtc) : NaN;
  if (!Number.isFinite(at)) return 'missing';
  if (at < now + MIN_SCHEDULE_LEAD_MS) return 'tooSoon';
  if (at > now + MAX_SCHEDULE_LEAD_MS) return 'tooFar';
  return null;
}
