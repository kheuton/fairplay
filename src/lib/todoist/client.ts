/**
 * Todoist API v1 HTTP client.
 *
 * VERIFIED AGAINST LIVE API (2026-06-11):
 *   Base URL:    https://api.todoist.com
 *   Proxy path:  /todoist-api  →  https://api.todoist.com  (Vite proxy)
 *   Auth:        Authorization: Bearer <token>
 *
 *   Projects endpoint:
 *     GET /api/v1/projects?limit=200
 *     Response: { results: RawProject[], next_cursor?: string }
 *     Project fields: id (string), name, parent_id (string|null), child_order (number),
 *       color, view_style, is_archived, is_deleted, is_favorite, description, inbox_project
 *
 *   Tasks endpoint:
 *     GET /api/v1/tasks?project_id=X&limit=200[&cursor=X]
 *     GET /api/v1/tasks?state=completed&project_id=X&limit=200
 *     Response: { results: RawTask[], next_cursor?: string }
 *     Task fields: id, content, description, labels (string[]), project_id, section_id,
 *       parent_id, due (null | { date, datetime?, string, is_recurring, timezone? }),
 *       priority (1-4), checked (bool — NOT is_completed), is_deleted,
 *       added_at, completed_at (null when open), updated_at, child_order
 *     IMPORTANT: tasks do NOT have a `url` field — construct as
 *       https://app.todoist.com/app/task/{id}
 *     IMPORTANT: completion is signaled by `checked` field, not `is_completed`
 *
 *   Close task:   POST /api/v1/tasks/{id}/close   (empty body, 204)
 *   Reopen task:  POST /api/v1/tasks/{id}/reopen  (empty body, 204)
 *   Create task:  POST /api/v1/tasks              (body: content, project_id, due_string,
 *                   description, labels, priority)
 *   Update task:  POST /api/v1/tasks/{id}         (body: same fields, partial)
 *   Delete task:  DELETE /api/v1/tasks/{id}       (204)
 *   Get task:     GET /api/v1/tasks/{id}
 *
 *   Bulk completed tasks: GET /api/v1/tasks/completed/by_completion_date
 *     Params: since (ISO datetime), until (ISO datetime), project_id (optional),
 *             limit (max results per page), cursor (pagination)
 *     Response: { items: RawTask[], next_cursor?: string }
 *     NOTE: response key is 'items', NOT 'results' (unlike other endpoints)
 *     Max time window: 3 months per request.
 *     The endpoint at /api/v1/tasks/completed_by_completion_date (no slash) requires
 *     a task_id param and returns single-task completion history — that's different.
 *
 *   Rate limits: HTTP 429, Retry-After header (not always present — default 1s retry).
 *   Pagination:  cursor param; response has next_cursor when more pages exist.
 */

import { getToken } from '../../state/settings';

const BASE = (import.meta.env.VITE_TODOIST_BASE as string | undefined) ?? '/todoist-api';

// ---------------------------------------------------------------------------
// Raw API shapes (verified against live API)
// ---------------------------------------------------------------------------

export interface RawProject {
  id: string;
  name: string;
  parent_id: string | null;
  child_order: number;
  color: string;
  view_style: string;
  is_archived: boolean;
  is_deleted: boolean;
  is_favorite: boolean;
  description: string;
  inbox_project?: boolean;
}

export interface RawDue {
  date: string;
  datetime?: string;
  string: string;
  is_recurring: boolean;
  timezone?: string;
}

export interface RawTask {
  id: string;
  content: string;
  description: string;
  labels: string[];
  project_id: string;
  section_id: string | null;
  parent_id: string | null;
  due: RawDue | null;
  priority: number;
  /** completion status — named `checked` in API v1 (NOT is_completed) */
  checked: boolean;
  is_deleted: boolean;
  added_at: string;
  completed_at: string | null;
  updated_at: string;
  child_order: number;
}

export interface PagedResponse<T> {
  results: T[];
  next_cursor?: string;
}

// ---------------------------------------------------------------------------
// Core request helpers
// ---------------------------------------------------------------------------

function requireToken(): string {
  const token = getToken();
  if (!token) throw new Error('No Todoist API token configured');
  return token;
}

async function fetchWithRetry(
  input: string,
  init: RequestInit,
  retried = false
): Promise<Response> {
  const res = await fetch(input, init);

  if (res.status === 429 && !retried) {
    const retryAfter = res.headers.get('Retry-After');
    const delayMs = retryAfter ? parseFloat(retryAfter) * 1000 : 1000;
    await new Promise((r) => setTimeout(r, delayMs));
    return fetchWithRetry(input, init, true);
  }

  return res;
}

export async function todoistGet<T>(path: string): Promise<T> {
  const token = requireToken();
  const res = await fetchWithRetry(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Todoist GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function todoistPost<T>(path: string, body?: unknown): Promise<T> {
  const token = requireToken();
  const res = await fetchWithRetry(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Todoist POST ${path} → ${res.status}`);
  // 204 No Content — return empty object cast to T
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

export async function todoistDelete(path: string): Promise<void> {
  const token = requireToken();
  const res = await fetchWithRetry(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Todoist DELETE ${path} → ${res.status}`);
}

// ---------------------------------------------------------------------------
// Pagination aggregator
// ---------------------------------------------------------------------------

/**
 * Fetch all pages for a cursor-paginated endpoint.
 * Constructs URL as `${path}${path.includes('?') ? '&' : '?'}cursor=...`
 * Response envelope: { results: T[], next_cursor?: string }
 */
export async function fetchAllPages<T>(path: string): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;

  do {
    const sep = path.includes('?') ? '&' : '?';
    const url = cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path;
    const page = await todoistGet<PagedResponse<T>>(url);
    all.push(...page.results);
    cursor = page.next_cursor;
  } while (cursor);

  return all;
}

/**
 * Response envelope for the completed/by_completion_date endpoint.
 * NOTE: uses 'items' (not 'results') — different from other paginated endpoints.
 */
export interface CompletedPagedResponse<T> {
  items: T[];
  next_cursor?: string;
}

/**
 * Fetch all pages for the completed/by_completion_date endpoint.
 * Uses the 'items' envelope key instead of 'results'.
 */
export async function fetchAllCompletedPages<T>(path: string): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;

  do {
    const sep = path.includes('?') ? '&' : '?';
    const url = cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path;
    const page = await todoistGet<CompletedPagedResponse<T>>(url);
    all.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);

  return all;
}
