import {
  format,
  isToday,
  isTomorrow,
  differenceInCalendarDays,
  parseISO,
  getHours,
} from 'date-fns';
import type { FpTask } from './types';

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

/** Format the month header label, e.g. "JUN 2026". */
export function monthLabel(date: Date): string {
  return MONTHS[date.getMonth()] + ' ' + date.getFullYear();
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

      if (isToday(dt)) {
        const hr = getHours(dt);
        const timeStr = format(dt, 'h:mm aa').toUpperCase();
        if (hr >= 17) {
          return { main: 'Tonight', sub: timeStr, over };
        }
        return { main: timeStr, sub: 'today', over };
      }

      if (isTomorrow(dt)) {
        return { main: 'Tomorrow', sub: format(dt, 'h:mm aa').toUpperCase(), over };
      }

      // Within 7 days
      const diff = differenceInCalendarDays(dt, ref);
      if (diff > 0 && diff <= 7) {
        return { main: format(dt, 'EEE MMM d'), sub: format(dt, 'h:mm aa').toUpperCase(), over };
      }

      if (over) {
        const days = differenceInCalendarDays(ref, dt);
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
    const diff = differenceInCalendarDays(d, ref);
    const over = diff < 0;

    if (isToday(d)) {
      // No time info — treat as "tonight"
      return { main: 'Tonight', sub: '', over: false };
    }

    if (isTomorrow(d)) {
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
