/**
 * FAIRPLAY · Triage bucketing
 * ──────────────────────────────────────────────────────────────────────────
 * Shared time-grouping of FpTasks into OVERDUE / TODAY / THIS WEEK / LATER.
 * Used by BOTH the desktop InboxPage and the mobile screens so the two
 * presentations always agree on how a task is bucketed (single source of truth).
 */
import { startOfDay, parseISO, differenceInCalendarDays } from 'date-fns';
import type { FpTask } from './types';

export type TriageGroup = 'OVERDUE' | 'TODAY' | 'THIS WEEK' | 'LATER';

/** Buckets in display order. */
export const TRIAGE_ORDER: TriageGroup[] = ['OVERDUE', 'TODAY', 'THIS WEEK', 'LATER'];

/** Which group a task falls into relative to `now`. Undated → LATER. */
export function getTriageGroup(task: FpTask, now: Date): TriageGroup {
  if (!task.due) return 'LATER';

  try {
    const ref = startOfDay(now);
    // Use datetime if available, else parse date string
    const dStr = task.due.datetime ?? task.due.date;
    const d = parseISO(dStr);
    const diff = differenceInCalendarDays(d, ref);

    if (diff < 0) return 'OVERDUE';
    if (diff === 0) return 'TODAY';
    if (diff <= 7) return 'THIS WEEK';
    return 'LATER';
  } catch {
    return 'LATER';
  }
}

/** Stable comparator by due date (undated last). */
export function sortByDue(a: FpTask, b: FpTask): number {
  if (!a.due && !b.due) return 0;
  if (!a.due) return 1;
  if (!b.due) return -1;
  const aStr = a.due.datetime ?? a.due.date;
  const bStr = b.due.datetime ?? b.due.date;
  return aStr.localeCompare(bStr);
}

/** Group tasks into the four triage buckets, each sorted by due date. */
export function groupByTriage(tasks: FpTask[], now: Date): Record<TriageGroup, FpTask[]> {
  const groups: Record<TriageGroup, FpTask[]> = {
    OVERDUE: [],
    TODAY: [],
    'THIS WEEK': [],
    LATER: [],
  };
  for (const task of tasks) groups[getTriageGroup(task, now)].push(task);
  for (const g of TRIAGE_ORDER) groups[g].sort(sortByDue);
  return groups;
}
