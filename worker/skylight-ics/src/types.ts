/**
 * Shared type definitions for the Skylight ICS Worker.
 *
 * These mirror the relevant subset of the FairPlay app's Todoist API types
 * without any browser-specific imports, so they are safe in a Workers runtime.
 *
 * MIRRORS: src/lib/todoist/client.ts (RawProject, RawDue, RawTask)
 * MIRRORS: src/lib/types.ts (CardDef subset)
 */

// ---------------------------------------------------------------------------
// Todoist REST API v1 raw shapes
// ---------------------------------------------------------------------------

export interface RawProject {
  id: string;
  name: string;
  parent_id: string | null;
  child_order: number;
  color?: string;
  view_style?: string;
  is_archived?: boolean;
  is_deleted?: boolean;
  is_favorite?: boolean;
  description?: string;
  inbox_project?: boolean;
}

export interface RawDue {
  /** YYYY-MM-DD */
  date: string;
  /** ISO 8601 datetime string (present when a specific time is set) */
  datetime?: string;
  /** Todoist's natural-language recurrence string, e.g. "every day" */
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
  is_deleted?: boolean;
  added_at?: string;
  completed_at?: string | null;
  updated_at?: string;
  child_order?: number;
}

export interface PagedResponse<T> {
  results: T[];
  next_cursor?: string;
}

// ---------------------------------------------------------------------------
// Deck / Card types
// ---------------------------------------------------------------------------

export interface CardDef {
  id: string;
  todoistId: string;
  num: string;
  name: string;
  category: string;
  kind: string;
  color?: string;
}

// ---------------------------------------------------------------------------
// Worker environment bindings
// ---------------------------------------------------------------------------

export interface Env {
  /** Todoist personal API token — set via `wrangler secret put TODOIST_API_TOKEN` */
  TODOIST_API_TOKEN: string;
  /** Shared feed secret — callers must pass ?key=<FEED_KEY> to read feeds */
  FEED_KEY?: string;
}
