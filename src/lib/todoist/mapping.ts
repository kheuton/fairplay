/**
 * Mapping between raw Todoist API v1 task objects and FpTask.
 *
 * VERIFIED FIELD NOTES (live API 2026-06-11):
 *   - Completion is signaled by `checked: boolean`, NOT `is_completed` (field does not exist).
 *   - Tasks have NO `url` field — constructed as https://app.todoist.com/app/task/{id}.
 *   - `due` object fields: date, datetime?, string, is_recurring, timezone?
 *   - `labels` is string[] of label names (not ids) in API v1.
 *   - Response wrapper: { results: RawTask[], next_cursor?: string }
 *
 * NOTE: cardId is derived from the task's project_id, NOT from labels.
 * The caller must pass the projectIdToCardId lookup map built from useDeck().
 */

import { parseFp } from '../metadata';
import type { FpTask, FpDue } from '../types';
import type { RawTask } from './client';

export type { RawTask };

/** Construct the Todoist web URL for a task. */
export function taskUrl(id: string): string {
  return `https://app.todoist.com/app/task/${id}`;
}

/**
 * Convert a raw Todoist task to FpTask.
 * @param raw            The raw API task object.
 * @param projectToCard  Map from Todoist project_id -> card slug (id).
 *                       Pass null for carrier tasks (FP-item / FP-config) where cardId is irrelevant.
 */
export function rawToFpTask(
  raw: RawTask,
  projectToCard: Map<string, string> | null
): FpTask {
  const { meta, clean } = parseFp(raw.description ?? '');

  const cardId = projectToCard ? (projectToCard.get(raw.project_id) ?? null) : null;

  let due: FpDue | null = null;
  if (raw.due) {
    due = {
      date: raw.due.date,
      datetime: raw.due.datetime,
      string: raw.due.string,
      isRecurring: raw.due.is_recurring,
    };
  }

  const priority = ([1, 2, 3, 4] as const).includes(raw.priority as 1 | 2 | 3 | 4)
    ? (raw.priority as 1 | 2 | 3 | 4)
    : 1;

  return {
    id: raw.id,
    content: clean || raw.content,
    description: clean,
    cardId,
    labels: raw.labels ?? [],
    due,
    priority,
    // API v1 uses `checked` for completion status (not `is_completed`)
    isCompleted: raw.checked,
    // Tasks have no url field in API v1 — construct from id
    url: taskUrl(raw.id),
    meta,
  };
}
