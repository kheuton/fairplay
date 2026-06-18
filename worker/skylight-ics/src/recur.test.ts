/**
 * Tests for the Todoist NL → RRULE converter (src/recur.ts).
 *
 * Covers:
 *   • Non-recurring tasks → rrule=null, unparseable=false
 *   • every day / daily
 *   • every weekday / every workday
 *   • every <N> days
 *   • every week / every N weeks
 *   • every month / every N months
 *   • every Nth (day of month)
 *   • every year / yearly / annually
 *   • every <weekday-name>  (single and multi-day)
 *   • Unrecognised strings → unparseable=true, rrule=null (safe fallback)
 *   • Case-insensitivity
 */

import { describe, it, expect } from 'vitest';
import { toRrule } from './recur.js';

describe('toRrule — non-recurring', () => {
  it('returns null/false when is_recurring=false', () => {
    const r = toRrule('every day', false);
    expect(r).toEqual({ rrule: null, unparseable: false });
  });

  it('returns null/false when dueString is empty', () => {
    const r = toRrule('', true);
    expect(r).toEqual({ rrule: null, unparseable: false });
  });

  it('returns null/false when dueString is undefined', () => {
    const r = toRrule(undefined, true);
    expect(r).toEqual({ rrule: null, unparseable: false });
  });
});

describe('toRrule — every day / daily', () => {
  it('handles "every day"', () => {
    expect(toRrule('every day', true).rrule).toBe('FREQ=DAILY;INTERVAL=1');
  });

  it('handles "daily"', () => {
    expect(toRrule('daily', true).rrule).toBe('FREQ=DAILY;INTERVAL=1');
  });

  it('handles "Every Day" (case-insensitive)', () => {
    expect(toRrule('Every Day', true).rrule).toBe('FREQ=DAILY;INTERVAL=1');
  });

  it('handles "every 1 day"', () => {
    expect(toRrule('every 1 day', true).rrule).toBe('FREQ=DAILY;INTERVAL=1');
  });
});

describe('toRrule — every N days', () => {
  it('handles "every 2 days"', () => {
    expect(toRrule('every 2 days', true).rrule).toBe('FREQ=DAILY;INTERVAL=2');
  });

  it('handles "every 3 days"', () => {
    expect(toRrule('every 3 days', true).rrule).toBe('FREQ=DAILY;INTERVAL=3');
  });

  it('handles "every 10 days"', () => {
    expect(toRrule('every 10 days', true).rrule).toBe('FREQ=DAILY;INTERVAL=10');
  });
});

describe('toRrule — weekday / workday', () => {
  it('handles "every weekday"', () => {
    expect(toRrule('every weekday', true).rrule).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  });

  it('handles "every workday"', () => {
    expect(toRrule('every workday', true).rrule).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  });

  it('handles "weekdays"', () => {
    expect(toRrule('weekdays', true).rrule).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  });
});

describe('toRrule — every week / every N weeks', () => {
  it('handles "every week"', () => {
    expect(toRrule('every week', true).rrule).toBe('FREQ=WEEKLY;INTERVAL=1');
  });

  it('handles "weekly"', () => {
    expect(toRrule('weekly', true).rrule).toBe('FREQ=WEEKLY;INTERVAL=1');
  });

  it('handles "every 2 weeks"', () => {
    expect(toRrule('every 2 weeks', true).rrule).toBe('FREQ=WEEKLY;INTERVAL=2');
  });

  it('handles "every 4 weeks"', () => {
    expect(toRrule('every 4 weeks', true).rrule).toBe('FREQ=WEEKLY;INTERVAL=4');
  });
});

describe('toRrule — named weekday(s)', () => {
  it('handles "every monday"', () => {
    expect(toRrule('every monday', true).rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
  });

  it('handles "every Friday"', () => {
    expect(toRrule('every Friday', true).rrule).toBe('FREQ=WEEKLY;BYDAY=FR');
  });

  it('handles abbreviation "every mon"', () => {
    expect(toRrule('every mon', true).rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
  });

  it('handles "every mon, wed, fri"', () => {
    expect(toRrule('every mon, wed, fri', true).rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR');
  });

  it('handles "every monday, wednesday, friday"', () => {
    expect(toRrule('every monday, wednesday, friday', true).rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR');
  });

  it('handles "every tuesday and thursday"', () => {
    const r = toRrule('every tuesday and thursday', true);
    expect(r.rrule).toBe('FREQ=WEEKLY;BYDAY=TU,TH');
  });

  it('deduplicates repeated days', () => {
    expect(toRrule('every mon, mon', true).rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
  });
});

describe('toRrule — every month / every N months', () => {
  it('handles "every month"', () => {
    expect(toRrule('every month', true).rrule).toBe('FREQ=MONTHLY;INTERVAL=1');
  });

  it('handles "monthly"', () => {
    expect(toRrule('monthly', true).rrule).toBe('FREQ=MONTHLY;INTERVAL=1');
  });

  it('handles "every 3 months"', () => {
    expect(toRrule('every 3 months', true).rrule).toBe('FREQ=MONTHLY;INTERVAL=3');
  });
});

describe('toRrule — every Nth (day of month)', () => {
  it('handles "every 1st"', () => {
    expect(toRrule('every 1st', true).rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=1');
  });

  it('handles "every 15th"', () => {
    expect(toRrule('every 15th', true).rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=15');
  });

  it('handles "every 31st"', () => {
    expect(toRrule('every 31st', true).rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=31');
  });

  it('handles "every 10th of the month"', () => {
    expect(toRrule('every 10th of the month', true).rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=10');
  });

  it('handles "every last day"', () => {
    expect(toRrule('every last day', true).rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=-1');
  });

  it('handles "every last day of the month"', () => {
    expect(toRrule('every last day of the month', true).rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=-1');
  });
});

describe('toRrule — every year / yearly / annually', () => {
  it('handles "every year"', () => {
    expect(toRrule('every year', true).rrule).toBe('FREQ=YEARLY;INTERVAL=1');
  });

  it('handles "yearly"', () => {
    expect(toRrule('yearly', true).rrule).toBe('FREQ=YEARLY;INTERVAL=1');
  });

  it('handles "annually"', () => {
    expect(toRrule('annually', true).rrule).toBe('FREQ=YEARLY;INTERVAL=1');
  });

  it('handles "annual"', () => {
    expect(toRrule('annual', true).rrule).toBe('FREQ=YEARLY;INTERVAL=1');
  });

  it('handles "every 2 years"', () => {
    expect(toRrule('every 2 years', true).rrule).toBe('FREQ=YEARLY;INTERVAL=2');
  });
});

describe('toRrule — unparseable fallback', () => {
  it('returns unparseable=true for "every other week"', () => {
    const r = toRrule('every other week', true);
    expect(r.rrule).toBeNull();
    expect(r.unparseable).toBe(true);
  });

  it('returns unparseable=true for "every 2nd tuesday"', () => {
    const r = toRrule('every 2nd tuesday', true);
    expect(r.rrule).toBeNull();
    expect(r.unparseable).toBe(true);
  });

  it('returns unparseable=true for "every weeknight"', () => {
    const r = toRrule('every weeknight', true);
    expect(r.rrule).toBeNull();
    expect(r.unparseable).toBe(true);
  });

  it('returns unparseable=true for a free-text string like "every time I do laundry"', () => {
    const r = toRrule('every time I do laundry', true);
    expect(r.rrule).toBeNull();
    expect(r.unparseable).toBe(true);
  });

  it('returns unparseable=true for "every monday morning"', () => {
    const r = toRrule('every monday morning', true);
    expect(r.rrule).toBeNull();
    expect(r.unparseable).toBe(true);
  });
});
