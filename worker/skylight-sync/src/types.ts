/**
 * Shared type definitions for the Skylight Sync Worker.
 *
 * Env: Worker bindings + runtime config knobs.
 * Domain types: RawTask (Todoist), ChoreResource (Skylight), MappingRow (D1).
 * ReconcileAction: the pure decision output consumed by index.ts.
 *
 * MIRRORS patterns from worker/skylight-ics/src/types.ts.
 */

// ---------------------------------------------------------------------------
// Worker environment bindings
// ---------------------------------------------------------------------------

export interface Env {
  // ── D1 database ────────────────────────────────────────────────────────────
  /** D1 database binding — set via [[d1_databases]] in wrangler.jsonc */
  DB: D1Database;

  // ── KV namespace ───────────────────────────────────────────────────────────
  /** KV namespace for tokens, lease, frame fingerprint */
  KV: KVNamespace;

  // ── Secrets (wrangler secret put ...) ─────────────────────────────────────
  TODOIST_API_TOKEN: string;
  SKYLIGHT_EMAIL: string;
  SKYLIGHT_PASSWORD: string;

  // ── Vars (set in wrangler.jsonc vars block or .dev.vars) ──────────────────
  /**
   * Which frame to sync against.
   * '5356033' = real "heutoncal" frame
   * '5381689' = test "thehd" frame
   */
  FRAME: string;

  /**
   * Must equal the frame fingerprint string (e.g. '5356033:heutoncal') to
   * allow any non-GET write on the real frame. Default empty → real-frame
   * writes hard-abort. The test frame requires '5381689:thehd'.
   */
  FRAME_CONFIRMED: string;

  /**
   * When 'true' (the default), all non-GET calls short-circuit inside
   * skylight-client.ts and return synthetic logged results. No Skylight
   * mutation escapes. Must be explicitly set to 'false' to enable writes.
   */
  DRYRUN: string;

  /**
   * Category IDs for each profile on this frame (JSON object).
   * Example: '{"kyle":"20976592","amy":"20976818"}'
   * Set as a var in wrangler.jsonc or .dev.vars.
   */
  PROFILE_CATEGORY_MAP: string;

  /**
   * Frame timezone string, e.g. 'America/New_York'.
   * Used to compute frame-local "today" — NOT new Date() local.
   */
  FRAME_TIMEZONE: string;
}

// ---------------------------------------------------------------------------
// Todoist REST API v1 raw shapes
// MIRRORS worker/skylight-ics/src/types.ts
// ---------------------------------------------------------------------------

export interface RawProject {
  id: string;
  name: string;
  parent_id: string | null;
  child_order: number;
}

export interface CardDef {
  id: string;
  todoistId: string;
  num: string;
  name: string;
  kind: string;
  category: string;
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
  /** completion status — named `checked` in API v1 */
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
// Skylight API shapes
// ---------------------------------------------------------------------------

/** Attributes of a chore resource returned by GET /api/frames/{id}/chores */
export interface ChoreAttributes {
  summary: string;
  status: 'pending' | 'complete' | string;
  start: string | null;           // YYYY-MM-DD
  start_time: string | null;
  recurring: boolean;
  completed_on: string | null;    // YYYY-MM-DD, set by server on completion
  emoji_icon: string | null;
  reward_points: number | null;
  category_id: string | null;
  category_ids: string[] | null;
  up_for_grabs?: boolean;
  /**
   * Ownership marker written at create time: "FPSYNC|<todoistId>".
   * Used as the ownership-verification field instead of a summary sentinel.
   * Confirmed writable and round-trips via create_multiple + GET.
   */
  description?: string | null;
}

/** A single chore resource (JSON:API style) */
export interface ChoreResource {
  id: string;
  type: 'chore';
  attributes: ChoreAttributes;
  relationships?: {
    category?: { data: { id: string; type: string } | null };
  };
}

/** The result of a chore GET by id (single resource) */
export interface SingleChoreResponse {
  data: ChoreResource;
}

/** The result of a chore list GET */
export interface ChoreListResponse {
  data: ChoreResource[];
}

/** The result of a chore create_multiple POST */
export interface CreateChoreResponse {
  data: ChoreResource[];
}

/** Skylight frame attributes */
export interface FrameAttributes {
  name: string;
  timezone?: string;
}

export interface FrameResource {
  id: string;
  type: 'frame';
  attributes: FrameAttributes;
}

export interface SingleFrameResponse {
  data: FrameResource;
}

// ---------------------------------------------------------------------------
// Skylight Lists API shapes (phase 2c)
// ---------------------------------------------------------------------------

/** Attributes of a list returned by GET /api/frames/{id}/lists */
export interface ListAttributes {
  label: string;
  kind: string;
  color: string | null;
}

/** A single list resource */
export interface ListResource {
  id: string;
  type: 'list';
  attributes: ListAttributes;
}

/** Response from GET /api/frames/{id}/lists */
export interface ListsResponse {
  data: ListResource[];
}

/** Response from POST /api/frames/{id}/lists (create list) */
export interface CreateListResponse {
  data: ListResource;
}

/** Attributes of a list_item in the included[] array */
export interface ListItemAttributes {
  label: string;
  status: 'pending' | 'completed' | string;
  section: string | null;
  position: number | null;
  created_at: string | null;
}

/** A single list_item resource */
export interface ListItemResource {
  id: string;
  type: 'list_item';
  attributes: ListItemAttributes;
}

/** Response from POST .../list_items (create list item) */
export interface CreateListItemResponse {
  data: ListItemResource;
}

/** Response from GET /api/frames/{id}/lists/{listId} (includes list_items in included[]) */
export interface SingleListResponse {
  data: ListResource;
  included?: ListItemResource[];
}

// ---------------------------------------------------------------------------
// D1 mapping row
// ---------------------------------------------------------------------------

export interface MappingRow {
  todoist_id: string;
  fp_stable_id: string | null;
  occurrence_date: string;          // '' for non-recurring
  surface: 'chore' | 'list';
  frame_id: string;
  profile: string;
  skylight_id: string | null;
  expected_summary: string | null;
  last_pushed_status: string | null;
  observed_status: string | null;
  last_pushed_hash: string | null;
  state: MappingState;
  idem_token: string | null;
  updated_at: number | null;
}

export type MappingState =
  | 'creating'
  | 'active'
  | 'deleting'
  | 'deleted'
  | 'needs_review'
  | 'detached';

// ---------------------------------------------------------------------------
// Reconcile actions (output of pure decide() function in reconcile.ts)
// ---------------------------------------------------------------------------

export type ReconcileAction =
  | { type: 'CREATE_CHORE' }
  | { type: 'UPDATE_CHORE'; changes: Partial<{ summary: string; start: string }> }
  | { type: 'COMPLETE_CHORE' }
  | { type: 'DELETE_CHORE' }
  | { type: 'CLOSE_TODOIST' }     // device completed → close in Todoist
  | { type: 'REOPEN_TODOIST' }    // device reopened but Todoist closed → re-assert
  | { type: 'NOOP' }
  | { type: 'SKIP_RECURRING'; reason: string }
  | { type: 'SKIP_NO_DUE'; reason: string }
  | { type: 'SKIP_DETACHED'; reason: string }
  | { type: 'SKIP_FRAME_MISMATCH'; reason: string }
  /**
   * §5 Rolling-occurrence: the Todoist task's current due has advanced to a new
   * occurrence_date that strictly exceeds the stored one. Delete the old chore,
   * create a new one for newOccurrenceDate.
   */
  | { type: 'ROLL_CHORE'; newOccurrenceDate: string }
  /**
   * §5 Inbound device-complete of a recurring task's current-occurrence chore:
   * close Todoist (which advances the task's due) then roll.
   * newOccurrenceDate is the expected next due after the advance (may be '' if
   * unknown at decide() time — index.ts resolves it after the Todoist close).
   */
  | { type: 'CLOSE_AND_ROLL_TODOIST' }
  // ── Phase 2c: List surface actions ─────────────────────────────────────────
  /** No-due task not yet mapped → create a list_item in the dedicated list */
  | { type: 'CREATE_LIST_ITEM' }
  /** Todoist task completed → PUT {status:"completed"} on the list_item */
  | { type: 'COMPLETE_LIST_ITEM' }
  /** Delete the list_item (Todoist task gone or deleted from device) */
  | { type: 'DELETE_LIST_ITEM' }
  /**
   * Surface migration: task gained or lost a due date since last sync.
   * Delete the old-surface artifact (chore or list_item) and create the new one.
   * fromSurface: the surface stored in the existing mapping row.
   * toSurface: the new surface to create.
   */
  | { type: 'MIGRATE_SURFACE'; fromSurface: 'chore' | 'list'; toSurface: 'chore' | 'list' };
