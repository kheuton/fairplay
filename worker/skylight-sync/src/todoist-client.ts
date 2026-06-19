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

/**
 * Optional hook called once per actual HTTP fetch() inside todoistFetch.
 * Used by the subrequest counter to count every Todoist subrequest precisely.
 * A retry counts as an additional call (i.e., a 429-retry increments twice).
 */
export type TodoistFetchHook = () => void;

async function todoistFetch<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  token: string,
  body?: unknown,
  onFetch?: TodoistFetchHook
): Promise<T> {
  const url = `${TODOIST_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  onFetch?.();
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 429) {
    // Retry once after Retry-After
    const delay = parseFloat(res.headers.get('Retry-After') ?? '1') * 1000;
    await new Promise((r) => setTimeout(r, delay));
    onFetch?.(); // retry also counts as a subrequest
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

async function fetchAllPages<T>(path: string, token: string, onFetch?: TodoistFetchHook): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;

  do {
    const sep = path.includes('?') ? '&' : '?';
    const url = cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path;
    const page = await todoistFetch<PagedResponse<T>>('GET', url, token, undefined, onFetch);
    all.push(...page.results);
    cursor = page.next_cursor;
  } while (cursor);

  return all;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Fetch all projects from Todoist (paginated). */
export async function fetchProjects(token: string, onFetch?: TodoistFetchHook): Promise<RawProject[]> {
  return fetchAllPages<RawProject>('/api/v1/projects?limit=200', token, onFetch);
}

/** Fetch all tasks for a given project_id (paginated, active tasks only). */
export async function fetchTasksForProject(projectId: string, token: string, onFetch?: TodoistFetchHook): Promise<RawTask[]> {
  return fetchAllPages<RawTask>(
    `/api/v1/tasks?project_id=${encodeURIComponent(projectId)}&limit=200`,
    token,
    onFetch
  );
}

/**
 * Fetch ALL active (non-completed) tasks across all projects (paginated).
 * Used by fetchDeckTasks to avoid one-per-project requests.
 */
export async function fetchAllTasks(token: string, onFetch?: TodoistFetchHook): Promise<RawTask[]> {
  return fetchAllPages<RawTask>('/api/v1/tasks?limit=200', token, onFetch);
}

/**
 * Fetch all in-scope FairPlay deck tasks for a profile.
 * Excludes: carrier tasks (FP-item/FP-config/FP-charter).
 * Does NOT filter on due date or recurrence — reconcile.ts does that.
 *
 * EFFICIENCY: issues only ~2-3 Todoist API calls total (1 GET /projects page +
 * 1-2 GET /tasks pages) regardless of how many deck projects exist. The
 * per-project fetchTasksForProject approach previously made N+1 calls for N
 * deck projects (60+ on a real account), exhausting the Cloudflare free-plan
 * subrequest budget of 50.
 *
 * Algorithm:
 *   1. GET /projects (paginated) — resolve deck membership exactly as before
 *      via resolveDeck(projects, deckParent) → Set of deck project IDs
 *   2. GET /tasks (all, no project filter, paginated) — fetch ALL active tasks
 *   3. Filter in-memory: keep only tasks whose project_id is in the deck ID set
 *      AND that are not carrier tasks
 *
 * Deck membership logic (resolveDeck) is UNCHANGED — same projects count as the
 * deck (child projects of the profile-parent project), same CardDef shape.
 *
 * @param onFetch  Optional hook called once per actual HTTP fetch() — used by the
 *                 subrequest counter to count every Todoist call precisely.
 *                 Called for every page of GET /projects AND every page of GET /tasks.
 */
export async function fetchDeckTasks(
  profile: ProfileId,
  token: string,
  onFetch?: TodoistFetchHook
): Promise<RawTask[]> {
  // Step 1: fetch all projects (typically 1 paginated call) to resolve deck membership
  const projects = await fetchProjects(token, onFetch);
  const deck = resolveDeck(projects, PROFILES[profile].deckParent);

  // Build a Set of project IDs that belong to this profile's deck
  const deckProjectIds = new Set(deck.map((card) => card.todoistId));

  // Step 2: fetch ALL active tasks in one paginated sweep (typically 1-2 calls)
  const allTasks = await fetchAllTasks(token, onFetch);

  // Step 3: in-memory filter — keep tasks in deck projects, exclude carriers
  return allTasks.filter(
    (t) => deckProjectIds.has(t.project_id) && !isCarrierTask(t.labels)
  );
}

/** Returns true if any label marks the task as a carrier. */
export function isCarrierTask(labels: string[]): boolean {
  return labels.some((l) => CARRIER_LABELS.has(l));
}

/**
 * Close (complete) a Todoist task.
 * Uses POST /api/v1/tasks/{id}/close (REST v1 idiom).
 */
export async function closeTask(taskId: string, token: string, onFetch?: TodoistFetchHook): Promise<void> {
  await todoistFetch<null>('POST', `/api/v1/tasks/${encodeURIComponent(taskId)}/close`, token, undefined, onFetch);
}

/**
 * Reopen a Todoist task.
 * Uses POST /api/v1/tasks/{id}/reopen.
 */
export async function reopenTask(taskId: string, token: string, onFetch?: TodoistFetchHook): Promise<void> {
  await todoistFetch<null>('POST', `/api/v1/tasks/${encodeURIComponent(taskId)}/reopen`, token, undefined, onFetch);
}

/**
 * Fetch a single task by id.
 * Returns null on 404.
 */
export async function getTask(taskId: string, token: string, onFetch?: TodoistFetchHook): Promise<RawTask | null> {
  try {
    return await todoistFetch<RawTask>('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}`, token, undefined, onFetch);
  } catch (err) {
    if (err instanceof TodoistApiError && err.status === 404) return null;
    throw err;
  }
}
