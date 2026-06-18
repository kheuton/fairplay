/**
 * Todoist natural-language recurrence → RFC-5545 RRULE converter.
 *
 * Design contract
 * ───────────────
 * • Input:  due.string (Todoist NL) + due.is_recurring flag
 * • Output: { rrule: string | null; unparseable: boolean }
 *   - rrule === null and unparseable === false → not a recurring task
 *   - rrule !== null                           → a valid RRULE to embed
 *   - rrule === null and unparseable === true  → couldn't map; caller should
 *     emit a single VEVENT with no RRULE (and set X-FP-RECUR for traceability)
 *
 * Covered patterns (case-insensitive, extra whitespace tolerant):
 *   every day / daily
 *   every weekday / every workday
 *   every <weekday-name(s)>                    e.g. "every monday, wednesday, friday"
 *   every week / every <N> weeks
 *   every <N> days
 *   every month                                (monthly on same day-of-month)
 *   every Nth / every <N>th of the month       e.g. "every 15th"
 *   every year / yearly / annually / annual
 *
 * For anything else the function returns unparseable=true so the caller
 * can safely fall back to a single VEVENT instead of emitting a wrong rule.
 */

export interface RecurResult {
  /** RFC-5545 RRULE value string (without "RRULE:" prefix), or null. */
  rrule: string | null;
  /** True when is_recurring=true but we could not produce a safe RRULE. */
  unparseable: boolean;
}

// Map Todoist day names to RFC-5545 two-letter day codes
const DAY_MAP: Record<string, string> = {
  monday:    'MO',
  mon:       'MO',
  tuesday:   'TU',
  tue:       'TU',
  wednesday: 'WE',
  wed:       'WE',
  thursday:  'TH',
  thu:       'TH',
  friday:    'FR',
  fri:       'FR',
  saturday:  'SA',
  sat:       'SA',
  sunday:    'SU',
  sun:       'SU',
};

/**
 * Parse a Todoist due.string into an RFC-5545 RRULE (or fallback signal).
 *
 * @param dueString  - Todoist due.string (may be undefined/empty for non-recurring)
 * @param isRecurring - Todoist due.is_recurring flag
 */
export function toRrule(dueString: string | undefined, isRecurring: boolean): RecurResult {
  // Not a recurring task at all
  if (!isRecurring || !dueString) {
    return { rrule: null, unparseable: false };
  }

  const s = dueString.trim().toLowerCase();

  // ── every day / daily ────────────────────────────────────────────────────
  if (s === 'every day' || s === 'daily' || s === 'every 1 day' || s === 'every 1 days') {
    return { rrule: 'FREQ=DAILY;INTERVAL=1', unparseable: false };
  }

  // ── every weekday / every workday ─────────────────────────────────────────
  if (s === 'every weekday' || s === 'every workday' || s === 'weekdays') {
    return { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', unparseable: false };
  }

  // ── every <N> days ────────────────────────────────────────────────────────
  const everyNDays = /^every\s+(\d+)\s+days?$/.exec(s);
  if (everyNDays) {
    const n = parseInt(everyNDays[1], 10);
    return { rrule: `FREQ=DAILY;INTERVAL=${n}`, unparseable: false };
  }

  // ── every week ────────────────────────────────────────────────────────────
  if (s === 'every week' || s === 'weekly' || s === 'every 1 week' || s === 'every 1 weeks') {
    return { rrule: 'FREQ=WEEKLY;INTERVAL=1', unparseable: false };
  }

  // ── every <N> weeks ───────────────────────────────────────────────────────
  const everyNWeeks = /^every\s+(\d+)\s+weeks?$/.exec(s);
  if (everyNWeeks) {
    const n = parseInt(everyNWeeks[1], 10);
    return { rrule: `FREQ=WEEKLY;INTERVAL=${n}`, unparseable: false };
  }

  // ── every month ───────────────────────────────────────────────────────────
  if (s === 'every month' || s === 'monthly' || s === 'every 1 month' || s === 'every 1 months') {
    return { rrule: 'FREQ=MONTHLY;INTERVAL=1', unparseable: false };
  }

  // ── every <N> months ──────────────────────────────────────────────────────
  const everyNMonths = /^every\s+(\d+)\s+months?$/.exec(s);
  if (everyNMonths) {
    const n = parseInt(everyNMonths[1], 10);
    return { rrule: `FREQ=MONTHLY;INTERVAL=${n}`, unparseable: false };
  }

  // ── every year / yearly / annual / annually ───────────────────────────────
  if (
    s === 'every year' ||
    s === 'yearly' ||
    s === 'annually' ||
    s === 'annual' ||
    s === 'every 1 year' ||
    s === 'every 1 years'
  ) {
    return { rrule: 'FREQ=YEARLY;INTERVAL=1', unparseable: false };
  }

  // ── every <N> years ───────────────────────────────────────────────────────
  const everyNYears = /^every\s+(\d+)\s+years?$/.exec(s);
  if (everyNYears) {
    const n = parseInt(everyNYears[1], 10);
    return { rrule: `FREQ=YEARLY;INTERVAL=${n}`, unparseable: false };
  }

  // ── every <Nth> (day of month) ────────────────────────────────────────────
  // e.g. "every 15th", "every 1st", "every 2nd of the month"
  const everyNth = /^every\s+(\d+)(?:st|nd|rd|th)(?:\s+of\s+the\s+month)?$/.exec(s);
  if (everyNth) {
    const day = parseInt(everyNth[1], 10);
    if (day >= 1 && day <= 31) {
      return { rrule: `FREQ=MONTHLY;BYMONTHDAY=${day}`, unparseable: false };
    }
  }

  // ── every last (day of month) ─────────────────────────────────────────────
  // e.g. "every last day", "every last day of the month"
  if (/^every\s+last\s+day(?:\s+of\s+the\s+month)?$/.test(s)) {
    return { rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1', unparseable: false };
  }

  // ── every <weekday-name(s)> ───────────────────────────────────────────────
  // e.g. "every monday", "every mon, wed, fri", "every tuesday and thursday"
  // Strip "every" prefix, then split on comma/and/whitespace
  const everyDaysPrefix = /^every\s+(.+)$/.exec(s);
  if (everyDaysPrefix) {
    const rest = everyDaysPrefix[1];
    // Split on comma, 'and', or whitespace sequences
    const tokens = rest.split(/[\s,]+(?:and\s*)?|and\s+/).map((t) => t.trim()).filter(Boolean);

    // All tokens must be valid day names
    const rfcDays: string[] = [];
    let allValid = true;
    for (const tok of tokens) {
      const rfcDay = DAY_MAP[tok];
      if (!rfcDay) {
        allValid = false;
        break;
      }
      rfcDays.push(rfcDay);
    }

    if (allValid && rfcDays.length > 0) {
      // Deduplicate while preserving order
      const unique = [...new Set(rfcDays)];
      const byDay = unique.join(',');
      return {
        rrule: `FREQ=WEEKLY;BYDAY=${byDay}`,
        unparseable: false,
      };
    }
  }

  // ── Unrecognised pattern — signal the caller to fall back ─────────────────
  return { rrule: null, unparseable: true };
}
