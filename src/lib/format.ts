import {
  format,
  differenceInCalendarDays,
  parseISO,
  getHours,
  startOfDay,
} from 'date-fns';
import type { FpTask } from './types';

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

/** Format the month header label, e.g. "JUN 2026". */
export function monthLabel(date: Date): string {
  return MONTHS[date.getMonth()] + ' ' + date.getFullYear();
}

/** Is `d` the same calendar day as `ref`? */
function isSameDay(d: Date, ref: Date): boolean {
  return (
    d.getFullYear() === ref.getFullYear() &&
    d.getMonth() === ref.getMonth() &&
    d.getDate() === ref.getDate()
  );
}

/** Is `d` the calendar day immediately after `ref`? */
function isNextDay(d: Date, ref: Date): boolean {
  const tomorrow = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + 1);
  return isSameDay(d, tomorrow);
}

/**
 * Compute main / sub due strings plus over flag.
 *
 * Rules (matching prototype):
 *   - Overdue date-only  → main: 'N days ago', sub: 'was Jun 6', over: true
 *   - Today with time    → main: '5:00 PM', sub: 'today' (evening = 'Tonight')
 *   - Today date-only    → main: 'Tonight', sub: '' (treat as evening fallback)
 *   - Tomorrow           → main: 'Tomorrow', sub: 'Jun 13'
 *   - Within 7 days      → main: 'Fri Jun 12', sub: '' (+ recur hint if recurring)
 *   - Else               → main: 'Jun 26', sub: '' (+ recur hint if recurring)
 *   - Recurring hint     → appended as sub: 'every friday' from due.string when > tomorrow
 *
 * The `now` parameter is used for all relative comparisons so tests can pin a
 * reference time without depending on the system clock.
 */
export function dueLabel(
  task: FpTask,
  now?: Date
): { main: string; sub: string; over: boolean } {
  const ref = now ?? new Date();
  const due = task.due;

  if (!due) return { main: '—', sub: '', over: false };

  // ── Has a datetime (time-specific) ──────────────────────────────────────────
  if (due.datetime) {
    try {
      const dt = parseISO(due.datetime);
      const over = dt < ref;

      if (isSameDay(dt, ref)) {
        const hr = getHours(dt);
        const timeStr = format(dt, 'h:mm aa').toUpperCase();
        if (hr >= 17) {
          return { main: 'Tonight', sub: timeStr, over };
        }
        return { main: timeStr, sub: 'today', over };
      }

      if (isNextDay(dt, ref)) {
        return { main: 'Tomorrow', sub: format(dt, 'h:mm aa').toUpperCase(), over };
      }

      // Within 7 days
      const diff = differenceInCalendarDays(startOfDay(dt), startOfDay(ref));
      if (diff > 0 && diff <= 7) {
        return { main: format(dt, 'EEE MMM d'), sub: format(dt, 'h:mm aa').toUpperCase(), over };
      }

      if (over) {
        const days = differenceInCalendarDays(startOfDay(ref), startOfDay(dt));
        return {
          main: days === 1 ? '1 day ago' : `${days} days ago`,
          sub: 'was ' + format(dt, 'MMM d'),
          over: true,
        };
      }

      return { main: format(dt, 'MMM d'), sub: format(dt, 'h:mm aa').toUpperCase(), over: false };
    } catch {
      // fall through to date-only
    }
  }

  // ── Date-only ────────────────────────────────────────────────────────────────
  try {
    const d = parseISO(due.date);
    const diff = differenceInCalendarDays(d, startOfDay(ref));
    const over = diff < 0;

    if (isSameDay(d, ref)) {
      // No time info — treat as "tonight"
      return { main: 'Tonight', sub: '', over: false };
    }

    if (isNextDay(d, ref)) {
      return { main: 'Tomorrow', sub: format(d, 'MMM d'), over: false };
    }

    if (over) {
      const days = Math.abs(diff);
      return {
        main: days === 1 ? '1 day ago' : `${days} days ago`,
        sub: 'was ' + format(d, 'MMM d'),
        over: true,
      };
    }

    // Within 7 days: "Fri Jun 12"
    const recurSub = due.isRecurring && due.string ? due.string : '';
    if (diff <= 7) {
      return { main: format(d, 'EEE MMM d'), sub: recurSub, over: false };
    }

    // Further out: "Jun 26"
    return { main: format(d, 'MMM d'), sub: recurSub, over: false };
  } catch {
    return { main: due.string, sub: '', over: false };
  }
}
