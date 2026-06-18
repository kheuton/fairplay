/**
 * Todoist REST API v1 client for the Sync Worker.
 *
 * Fetches FairPlay deck tasks for a given profile.
 * Closes (completes) and reopens tasks for inbound sync.
 *
 * MIRRORS patterns from worker/skylight-ics/src/index.ts.
 *
 * Rate-limit handling: 429 → honour Retry-After (once); on second 429
 * throw so the caller can checkpoint and exit cleanly (§10).
 */

import type { RawProject, RawTask, PagedResponse } from './types.js';
import { resolveDeck, PROFILES } from './deck.js';
import type { ProfileId } from './deck.js';

export const TODOIST_BASE = 'https://api.todoist.com';

/** Labels that mark carrier tasks — excluded from sync (mirrors feed.ts). */
const CARRIER_LABELS = new Set(['FP-item', 'FP-config', 'FP-charter']);

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function todoistFetch<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  token: string,
  body?: unknown
): Promise<T> {
  const url = `${TODOIST_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429) {
    // Retry once after Retry-After
    const delay = parseFloat(res.headers.get('Retry-After') ?? '1') * 1000;
    await new Promise((r) => setTimeout(r, delay));
    const retry = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (retry.status === 429) {
      throw new TodoistRateLimitError(
        `Todoist 429 on retry for ${method} ${path}. Exiting for checkpoint.`
      );
    }
    if (!retry.ok) {
      throw new TodoistApiError(`Todoist ${method} ${path} → ${retry.status}`, retry.status);
    }
    if (retry.status === 204) return null as T;
    return retry.json() as Promise<T>;
  }

  if (res.status === 401) {
    throw new TodoistApiError(`Todoist 401: ${path}`, 401);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new TodoistApiError(
      `Todoist ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`,
      res.status
    );
  }
  if (res.status === 204) return null as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TodoistApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'TodoistApiError';
  }
}

export class TodoistRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TodoistRateLimitError';
  }
}

// ---------------------------------------------------------------------------
// Paginated GET
// ---------------------------------------------------------------------------

async function fetchAllPages<T>(path: string, token: string): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;

  do {
    const sep = path.includes('?') ? '&' : '?';
    const url = cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path;
    const page = await todoistFetch<PagedResponse<T>>('GET', url, token);
    all.push(...page.results);
    cursor = page.next_cursor;
  } while (cursor);

  return all;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Fetch all projects from Todoist (paginated). */
export async function fetchProjects(token: string): Promise<RawProject[]> {
  return fetchAllPages<RawProject>('/api/v1/projects?limit=200', token);
}

/** Fetch all tasks for a given project_id (paginated, active tasks only). */
export async function fetchTasksForProject(projectId: string, token: string): Promise<RawTask[]> {
  return fetchAllPages<RawTask>(
    `/api/v1/tasks?project_id=${encodeURIComponent(projectId)}&limit=200`,
    token
  );
}

/**
 * Fetch all in-scope FairPlay deck tasks for a profile.
 * Excludes: carrier tasks (FP-item/FP-config/FP-charter).
 * Does NOT filter on due date or recurrence — reconcile.ts does that.
 */
export async function fetchDeckTasks(
  profile: ProfileId,
  token: string
): Promise<RawTask[]> {
  const projects = await fetchProjects(token);
  const deck = resolveDeck(projects, PROFILES[profile].deckParent);

  const taskArrays = await Promise.all(
    deck.map((card) => fetchTasksForProject(card.todoistId, token))
  );

  const all = taskArrays.flat();
  return all.filter((t) => !isCarrierTask(t.labels));
}

/** Returns true if any label marks the task as a carrier. */
export function isCarrierTask(labels: string[]): boolean {
  return labels.some((l) => CARRIER_LABELS.has(l));
}

/**
 * Close (complete) a Todoist task.
 * Uses POST /api/v1/tasks/{id}/close (REST v1 idiom).
 */
export async function closeTask(taskId: string, token: string): Promise<void> {
  await todoistFetch<null>('POST', `/api/v1/tasks/${encodeURIComponent(taskId)}/close`, token);
}

/**
 * Reopen a Todoist task.
 * Uses POST /api/v1/tasks/{id}/reopen.
 */
export async function reopenTask(taskId: string, token: string): Promise<void> {
  await todoistFetch<null>('POST', `/api/v1/tasks/${encodeURIComponent(taskId)}/reopen`, token);
}

/**
 * Fetch a single task by id.
 * Returns null on 404.
 */
export async function getTask(taskId: string, token: string): Promise<RawTask | null> {
  try {
    return await todoistFetch<RawTask>('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}`, token);
  } catch (err) {
    if (err instanceof TodoistApiError && err.status === 404) return null;
    throw err;
  }
}
