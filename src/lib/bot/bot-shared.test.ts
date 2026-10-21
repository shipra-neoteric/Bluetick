import { describe, expect, it } from 'vitest';
import { formatDate, formatPhone, parseDateInput } from './formatters';
import { DEFAULT_BUSINESS_HOURS, planWaitUntil, validateBusinessHours, workingHoursAt } from './working-hours';
import { interpolate, missingTokens, needsContact } from './variables';

describe('formatDate', () => {
  it('keeps date-only values on their calendar day', () => {
    expect(formatDate('2026-10-18', { outputFormat: 'DD MMM YYYY', outputTimezone: 'America/New_York' })).toEqual({ ok: true, value: '18 Oct 2026' });
    expect(formatDate('18/10/2026', { outputFormat: 'dddd, D MMMM' })).toEqual({ ok: true, value: 'Sunday, 18 October' });
    expect(formatDate('10/18/2026', { inputFormat: 'mdy', outputFormat: 'YYYY-MM-DD' })).toEqual({ ok: true, value: '2026-10-18' });
  });

  it('converts instants between zones', () => {
    // 09:30 IST = 04:00 UTC
    expect(formatDate('2026-10-18T09:30', { inputTimezone: 'Asia/Kolkata', outputTimezone: 'UTC', outputFormat: 'HH:mm' })).toEqual({ ok: true, value: '04:00' });
    expect(formatDate('2026-10-18T04:00:00Z', { outputTimezone: 'Asia/Kolkata', outputFormat: 'hh:mm A' })).toEqual({ ok: true, value: '09:30 AM' });
    expect(formatDate('1760760000', { inputFormat: 'epoch_s', outputTimezone: 'UTC', outputFormat: 'YYYY-MM-DD' })).toMatchObject({ ok: true });
  });

  it('fails clearly on bad input', () => {
    expect(formatDate('31/02/2026', { outputFormat: 'YYYY' }).ok).toBe(false);
    expect(formatDate('tomorrow', { outputFormat: 'YYYY' }).ok).toBe(false);
    expect(formatDate('2026-10-18', { outputFormat: 'YYYY', outputTimezone: 'Mars/Base' })).toEqual({ ok: false, error: 'Unknown time zone' });
    expect(parseDateInput('2026-13-01')).toBeNull();
  });
});

describe('formatPhone', () => {
  it('applies the default country only to national numbers', () => {
    expect(formatPhone('98765 43210', { defaultCountryCode: '91' })).toEqual({ ok: true, value: '+919876543210' });
    expect(formatPhone('+971 50 123 4567', { defaultCountryCode: '91' })).toEqual({ ok: true, value: '+971501234567' });
    expect(formatPhone('+919876543210', { output: 'national', defaultCountryCode: '91' })).toEqual({ ok: true, value: '9876543210' });
    expect(formatPhone('+919876543210', { output: 'digits' })).toEqual({ ok: true, value: '919876543210' });
  });

  it('never guesses a country', () => {
    expect(formatPhone('9876543210', {}).ok).toBe(false);
    expect(formatPhone('9.19876E+11', { defaultCountryCode: '91' }).ok).toBe(false);
  });
});

describe('working hours', () => {
  const hours = { ...DEFAULT_BUSINESS_HOURS, holidays: ['2026-10-20'] };
  it('routes by the account time zone', () => {
    // Mon 2026-10-19 10:00 IST = 04:30 UTC
    expect(workingHoursAt(new Date('2026-10-19T04:30:00Z'), hours)).toBe('open');
    // Mon 20:00 IST
    expect(workingHoursAt(new Date('2026-10-19T14:30:00Z'), hours)).toBe('closed');
    // Sunday
    expect(workingHoursAt(new Date('2026-10-18T05:00:00Z'), hours)).toBe('closed');
    // Holiday Tuesday during hours
    expect(workingHoursAt(new Date('2026-10-20T05:00:00Z'), hours)).toBe('holiday');
  });

  it('supports overnight windows and validates schedules', () => {
    const night = { timezone: 'UTC', schedule: { mon: [['22:00', '02:00']] as [string, string][] }, holidays: [] };
    expect(workingHoursAt(new Date('2026-10-19T23:00:00Z'), night)).toBe('open');
    expect(validateBusinessHours({ timezone: 'Nope/Zone', schedule: { mon: [['9', '18:00']] }, holidays: ['tomorrow'] })).toHaveLength(3);
  });
});

describe('wait until', () => {
  const now = new Date('2026-10-18T00:00:00Z');
  it('stores UTC from a wall time in an explicit zone, with offset before', () => {
    const p = planWaitUntil({ at: '2026-10-25T10:00', timezone: 'Asia/Kolkata', offset_minutes: 60 }, now);
    expect(p).toEqual({ ok: true, runAt: new Date('2026-10-25T03:30:00Z'), past: false });
  });
  it('flags past times and rejects junk', () => {
    expect(planWaitUntil({ at: '2026-01-01T10:00' }, now)).toMatchObject({ ok: true, past: true });
    expect(planWaitUntil({ at: 'next week' }, now).ok).toBe(false);
    expect(planWaitUntil({ at: '2026-10-25T10:00', timezone: 'Bad/Zone' }, now).ok).toBe(false);
  });
});

describe('variables', () => {
  const scope = {
    vars: { budget: '80L', lead: { project: 'Garden City' } },
    message: { text: 'hi' },
    contact: { name: 'Asha', phone: '+919000000001' },
    custom: { f1: 'Site visit' },
    trigger: { row: { city: 'Pune' } },
  };
  it('resolves every namespace and keeps legacy syntax', () => {
    expect(interpolate('{{contact.name}} {{vars.budget}} {{ vars.lead.project }} {{message.text}} {{contact.custom.f1}} {{trigger.row.city}}', scope))
      .toBe('Asha 80L Garden City hi Site visit Pune');
  });
  it('reports unknown tokens and never walks prototypes', () => {
    expect(missingTokens('{{vars.nope}} {{contact.name}} {{vars.__proto__}}', scope)).toEqual(['vars.nope', 'vars.__proto__']);
    expect(interpolate('{{vars.constructor}}', scope)).toBe('');
    expect(needsContact('Hi {{contact.custom.f1}}')).toEqual({ contact: true, custom: true });
  });
});
