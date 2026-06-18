/**
 * Feed builder for the Skylight ICS Worker.
 *
 * Converts an array of RawTask objects into a complete iCalendar (.ics) string.
 *
 * Filtering applied here (mirrors app's deck/chore selection rules):
 *   • EXCLUDE tasks with no due date (calendar events need a date)
 *   • EXCLUDE carrier tasks whose labels include FP-item, FP-config, or FP-charter
 *   • EXCLUDE tasks where checked === true (completed tasks need no future events)
 *
 * Recurrence:
 *   • Tasks with due.is_recurring=true → toRrule(due.string) → RRULE if parseable
 *   • Unparseable recurring tasks → single VEVENT on due.date (no RRULE),
 *     original due.string preserved in X-FP-RECUR for traceability
 */

import type { RawTask } from './types.js';
import { parseFp } from './metadata.js';
import { toRrule } from './recur.js';
import { buildVEvent, buildVCalendar } from './ics.js';

// ---------------------------------------------------------------------------
// Carrier label filter
// ---------------------------------------------------------------------------

const CARRIER_LABELS = new Set(['FP-item', 'FP-config', 'FP-charter']);

/**
 * Returns true if the task is a carrier task (inventory/config/charter) that
 * should be excluded from the ICS feed.
 */
export function isCarrierTask(labels: string[]): boolean {
  return labels.some((l) => CARRIER_LABELS.has(l));
}

// ---------------------------------------------------------------------------
// Single-task → VEVENT
// ---------------------------------------------------------------------------

/**
 * Convert one RawTask to a VEVENT block string.
 * Returns null if the task should be excluded (no due, carrier, or completed).
 */
export function taskToVEvent(task: RawTask, now: Date = new Date()): string | null {
  // Exclude completed tasks
  if (task.checked) return null;

  // Exclude tasks with no due date
  if (!task.due) return null;

  // Exclude carrier tasks
  if (isCarrierTask(task.labels)) return null;

  const { clean: description } = parseFp(task.description ?? '');
  const { rrule, unparseable } = toRrule(task.due.string, task.due.is_recurring);

  return buildVEvent({
    uid: `${task.id}@fairplay-skylight`,
    summary: task.content,
    description,
    date: task.due.date,
    datetime: task.due.datetime,
    rrule,
    // Always store original due.string in X-FP-RECUR for traceability
    fpRecur: task.due.is_recurring
      ? task.due.string + (unparseable ? ' [unparseable→single]' : '')
      : undefined,
    dtstamp: now,
  });
}

// ---------------------------------------------------------------------------
// Task list → VCALENDAR
// ---------------------------------------------------------------------------

/**
 * Convert a filtered array of RawTasks to a complete iCalendar string.
 *
 * @param tasks    - All tasks from the relevant deck project(s)
 * @param calName  - X-WR-CALNAME value shown in the calendar client
 * @param now      - Timestamp for DTSTAMP (injectable for testing)
 */
export function buildFeed(tasks: RawTask[], calName: string, now: Date = new Date()): string {
  const vevents: string[] = [];

  for (const task of tasks) {
    const vevent = taskToVEvent(task, now);
    if (vevent !== null) {
      vevents.push(vevent);
    }
  }

  return buildVCalendar({ calName, vevents });
}
