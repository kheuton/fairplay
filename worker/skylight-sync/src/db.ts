/**
 * D1 database access layer for the Skylight Sync Worker.
 *
 * Mapping + lease CRUD. All writes are parameterised to avoid injection.
 * Schema: see migrations/0001_init.sql
 *
 * SAFETY NOTES:
 * - Write-ahead semantics: insert with state='creating' BEFORE the HTTP call.
 * - Hard-delete rows only after Skylight confirms deletion (§9).
 * - UNIQUE(skylight_id, frame_id) enforced at DB level.
 */

import type { MappingRow, MappingState } from './types.js';

// ---------------------------------------------------------------------------
// Lease operations (single-writer guard, §2/§10)
// ---------------------------------------------------------------------------

/** Lease TTL in seconds — 5 minutes should be more than enough for a sync run. */
const LEASE_TTL_SECONDS = 300;

/**
 * Try to acquire the run lease. Returns true if acquired, false if another
 * run is still holding it.
 *
 * Strategy: read existing lease; if expired (or absent) insert/update ours;
 * if active and belongs to another run, return false.
 *
 * Note: D1 does not support SELECT ... FOR UPDATE, so there is a small race
 * window between read and write. The UNIQUE constraint on `id` (PRIMARY KEY)
 * plus an INSERT OR REPLACE with a run_id check provides best-effort
 * protection; true serialisation requires a Durable Object (§10 note).
 */
export async function acquireLease(db: D1Database, runId: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + LEASE_TTL_SECONDS;

  // Check for an active lease from a different run
  const existing = await db
    .prepare('SELECT run_id, expires_at FROM lease WHERE id = ?')
    .bind('singleton')
    .first<{ run_id: string; expires_at: number }>();

  if (existing && existing.expires_at > now && existing.run_id !== runId) {
    return false; // another run is active
  }

  // Insert or replace our lease
  await db
    .prepare(
      `INSERT INTO lease (id, run_id, expires_at, started_at)
       VALUES ('singleton', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,
         expires_at=excluded.expires_at, started_at=excluded.started_at`
    )
    .bind(runId, expiresAt, now)
    .run();

  return true;
}

/** Release the lease at the end of a run. */
export async function releaseLease(db: D1Database, runId: string): Promise<void> {
  await db
    .prepare('DELETE FROM lease WHERE id = ? AND run_id = ?')
    .bind('singleton', runId)
    .run();
}

// ---------------------------------------------------------------------------
// Mapping CRUD
// ---------------------------------------------------------------------------

/** Read all active mapping rows (state='active'). */
export async function getActiveMappings(db: D1Database): Promise<MappingRow[]> {
  const result = await db
    .prepare("SELECT * FROM mapping WHERE state = 'active'")
    .all<MappingRow>();
  return result.results ?? [];
}

/** Read a mapping row by (todoist_id, occurrence_date). */
export async function getMappingByTodoistId(
  db: D1Database,
  todoistId: string,
  occurrenceDate: string
): Promise<MappingRow | null> {
  return db
    .prepare('SELECT * FROM mapping WHERE todoist_id = ? AND occurrence_date = ?')
    .bind(todoistId, occurrenceDate)
    .first<MappingRow>();
}

/** Read mapping rows for a todoist_id across all occurrence_dates. */
export async function getMappingsByTodoistId(
  db: D1Database,
  todoistId: string
): Promise<MappingRow[]> {
  const result = await db
    .prepare('SELECT * FROM mapping WHERE todoist_id = ?')
    .bind(todoistId)
    .all<MappingRow>();
  return result.results ?? [];
}

/**
 * Write-ahead intent: insert a 'creating' row BEFORE the HTTP POST.
 * If a row already exists (e.g., from a partial prior run), leave it unless
 * state is 'creating' (idempotent resume).
 *
 * DRYRUN: no-ops — logs intent and returns without persisting.
 */
export async function insertCreatingRow(
  db: D1Database,
  row: Omit<MappingRow, 'updated_at'>,
  dryrun = false
): Promise<void> {
  if (dryrun) {
    console.log(
      `[db] DRYRUN: would insertCreatingRow ${row.todoist_id}/${row.occurrence_date}`
    );
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO mapping
         (todoist_id, fp_stable_id, occurrence_date, surface, frame_id, profile,
          skylight_id, expected_summary, last_pushed_status, observed_status,
          last_pushed_hash, state, idem_token, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(todoist_id, occurrence_date) DO NOTHING`
    )
    .bind(
      row.todoist_id,
      row.fp_stable_id ?? null,
      row.occurrence_date,
      row.surface,
      row.frame_id,
      row.profile,
      row.skylight_id ?? null,
      row.expected_summary ?? null,
      row.last_pushed_status ?? null,
      row.observed_status ?? null,
      row.last_pushed_hash ?? null,
      row.state,
      row.idem_token ?? null,
      now
    )
    .run();
}

/**
 * Commit a row to 'active' after a successful create + read-back.
 *
 * DRYRUN: no-ops — logs intent and returns without persisting.
 */
export async function commitActiveRow(
  db: D1Database,
  todoistId: string,
  occurrenceDate: string,
  skylightId: string,
  expectedSummary: string,
  lastPushedHash: string,
  dryrun = false
): Promise<void> {
  if (dryrun) {
    console.log(
      `[db] DRYRUN: would commitActiveRow ${todoistId}/${occurrenceDate} skylightId=${skylightId}`
    );
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `UPDATE mapping
       SET state = 'active', skylight_id = ?, expected_summary = ?,
           last_pushed_status = 'pending', last_pushed_hash = ?, updated_at = ?
       WHERE todoist_id = ? AND occurrence_date = ?`
    )
    .bind(skylightId, expectedSummary, lastPushedHash, now, todoistId, occurrenceDate)
    .run();
}

/**
 * Mark a row as needs_review (create mismatch, sentinel mismatch, etc.).
 *
 * DRYRUN: no-ops.
 */
export async function markNeedsReview(
  db: D1Database,
  todoistId: string,
  occurrenceDate: string,
  dryrun = false
): Promise<void> {
  if (dryrun) {
    console.log(`[db] DRYRUN: would markNeedsReview ${todoistId}/${occurrenceDate}`);
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `UPDATE mapping SET state = 'needs_review', updated_at = ?
       WHERE todoist_id = ? AND occurrence_date = ?`
    )
    .bind(now, todoistId, occurrenceDate)
    .run();
}

/**
 * Mark a row as detached (on-device summary diverged from expected_summary).
 *
 * DRYRUN: no-ops.
 */
export async function markDetached(
  db: D1Database,
  todoistId: string,
  occurrenceDate: string,
  dryrun = false
): Promise<void> {
  if (dryrun) {
    console.log(`[db] DRYRUN: would markDetached ${todoistId}/${occurrenceDate}`);
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `UPDATE mapping SET state = 'detached', updated_at = ?
       WHERE todoist_id = ? AND occurrence_date = ?`
    )
    .bind(now, todoistId, occurrenceDate)
    .run();
}

/**
 * Update last_pushed_status after a completeChore write.
 *
 * DRYRUN: no-ops.
 */
export async function updatePushedStatus(
  db: D1Database,
  todoistId: string,
  occurrenceDate: string,
  status: 'pending' | 'complete',
  dryrun = false
): Promise<void> {
  if (dryrun) {
    console.log(`[db] DRYRUN: would updatePushedStatus ${todoistId}/${occurrenceDate} → ${status}`);
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `UPDATE mapping SET last_pushed_status = ?, updated_at = ?
       WHERE todoist_id = ? AND occurrence_date = ?`
    )
    .bind(status, now, todoistId, occurrenceDate)
    .run();
}

/**
 * Update observed_status after an inbound GET.
 *
 * DRYRUN: no-ops.
 */
export async function updateObservedStatus(
  db: D1Database,
  todoistId: string,
  occurrenceDate: string,
  observedStatus: string,
  dryrun = false
): Promise<void> {
  if (dryrun) {
    console.log(`[db] DRYRUN: would updateObservedStatus ${todoistId}/${occurrenceDate} → ${observedStatus}`);
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `UPDATE mapping SET observed_status = ?, updated_at = ?
       WHERE todoist_id = ? AND occurrence_date = ?`
    )
    .bind(observedStatus, now, todoistId, occurrenceDate)
    .run();
}

/**
 * Update last_pushed_hash after a content update.
 *
 * DRYRUN: no-ops.
 */
export async function updatePushedHash(
  db: D1Database,
  todoistId: string,
  occurrenceDate: string,
  hash: string,
  dryrun = false
): Promise<void> {
  if (dryrun) {
    console.log(`[db] DRYRUN: would updatePushedHash ${todoistId}/${occurrenceDate}`);
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `UPDATE mapping SET last_pushed_hash = ?, updated_at = ?
       WHERE todoist_id = ? AND occurrence_date = ?`
    )
    .bind(hash, now, todoistId, occurrenceDate)
    .run();
}

/**
 * Begin a delete: set state='deleting'.
 *
 * DRYRUN: no-ops.
 */
export async function markDeleting(
  db: D1Database,
  todoistId: string,
  occurrenceDate: string,
  dryrun = false
): Promise<void> {
  if (dryrun) {
    console.log(`[db] DRYRUN: would markDeleting ${todoistId}/${occurrenceDate}`);
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `UPDATE mapping SET state = 'deleting', updated_at = ?
       WHERE todoist_id = ? AND occurrence_date = ?`
    )
    .bind(now, todoistId, occurrenceDate)
    .run();
}

/**
 * Hard-delete a row (only after Skylight confirms 404).
 * §9: hard-delete so a stale row can never re-match a reused id.
 *
 * DRYRUN: no-ops.
 */
export async function hardDeleteRow(
  db: D1Database,
  todoistId: string,
  occurrenceDate: string,
  dryrun = false
): Promise<void> {
  if (dryrun) {
    console.log(`[db] DRYRUN: would hardDeleteRow ${todoistId}/${occurrenceDate}`);
    return;
  }
  await db
    .prepare('DELETE FROM mapping WHERE todoist_id = ? AND occurrence_date = ?')
    .bind(todoistId, occurrenceDate)
    .run();
}

/** Read all rows in 'deleting' state (for stale-row sweep / orphan cleanup). */
export async function getDeletingMappings(db: D1Database): Promise<MappingRow[]> {
  const result = await db
    .prepare("SELECT * FROM mapping WHERE state = 'deleting'")
    .all<MappingRow>();
  return result.results ?? [];
}

/** Get all rows in 'needs_review' or 'detached' state (for ops alerting). */
export async function getReviewRows(db: D1Database): Promise<MappingRow[]> {
  const result = await db
    .prepare("SELECT * FROM mapping WHERE state IN ('needs_review', 'detached')")
    .all<MappingRow>();
  return result.results ?? [];
}

/** Read all active mapping rows filtered by surface (e.g. 'list'). */
export async function getActiveMappingsBySurface(
  db: D1Database,
  surface: 'chore' | 'list'
): Promise<MappingRow[]> {
  const result = await db
    .prepare("SELECT * FROM mapping WHERE state = 'active' AND surface = ?")
    .bind(surface)
    .all<MappingRow>();
  return result.results ?? [];
}

/**
 * §5 Roll: atomically move a mapping row from one occurrence_date to another.
 *
 * Since occurrence_date is part of the PK, we cannot UPDATE it in place.
 * Strategy: insert a fresh 'creating' row for newOccurrenceDate, then
 * hard-delete the old row. The caller commits the new row to 'active' after
 * the Skylight chore is successfully created (create-then-verify-then-record).
 *
 * IMPORTANT: the old row is deleted AFTER the new row is inserted so that a
 * crash between the two leaves a 'creating' row (resumable) rather than no row.
 *
 * DRYRUN: no-ops.
 */
export async function rollOccurrenceDate(
  db: D1Database,
  oldRow: MappingRow,
  newOccurrenceDate: string,
  newIdemToken: string,
  newExpectedSummary: string,
  dryrun = false
): Promise<void> {
  if (dryrun) {
    console.log(
      `[db] DRYRUN: would rollOccurrenceDate ${oldRow.todoist_id} ${oldRow.occurrence_date} → ${newOccurrenceDate}`
    );
    return;
  }
  const now = Math.floor(Date.now() / 1000);

  // Insert new 'creating' row for the next occurrence
  await db
    .prepare(
      `INSERT INTO mapping
         (todoist_id, fp_stable_id, occurrence_date, surface, frame_id, profile,
          skylight_id, expected_summary, last_pushed_status, observed_status,
          last_pushed_hash, state, idem_token, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(todoist_id, occurrence_date) DO NOTHING`
    )
    .bind(
      oldRow.todoist_id,
      oldRow.fp_stable_id ?? null,
      newOccurrenceDate,
      oldRow.surface,
      oldRow.frame_id,
      oldRow.profile,
      null,                  // skylight_id — unknown until create completes
      newExpectedSummary,
      null,                  // last_pushed_status
      null,                  // observed_status
      null,                  // last_pushed_hash
      'creating',
      newIdemToken,
      now
    )
    .run();

  // Hard-delete the old row (§9: hard-delete so stale row can't re-match)
  await db
    .prepare('DELETE FROM mapping WHERE todoist_id = ? AND occurrence_date = ?')
    .bind(oldRow.todoist_id, oldRow.occurrence_date)
    .run();
}
