/**
 * Pure reconcile logic for the Skylight Sync Worker.
 *
 * This module contains ONLY pure decision functions with no I/O.
 * All inputs are plain values; all outputs are ReconcileAction structs.
 * This makes the entire module trivially unit-testable.
 *
 * Key functions:
 *   surface(task)         → 'chore' | 'skip_no_due' | 'skip_recurring'
 *   fingerprint(task)     → stable hash of content + due date
 *   decide(task, row, chore) → ReconcileAction[]
 *
 * Design spec references: §5, §6, §7, §8.
 */

import type { RawTask, MappingRow, ChoreResource, ReconcileAction } from './types.js';
import { parseFp } from './metadata.js';

// ---------------------------------------------------------------------------
// surface(): classify a task for phase 2a/2b/2c
// ---------------------------------------------------------------------------

export type SurfaceResult =
  | { kind: 'chore'; occurrenceDate: string; isRecurring: boolean }
  | { kind: 'list' }
  | { kind: 'skip_recurring'; reason: string };

/**
 * Classify a task's surface for phase 2a/2b/2c.
 *
 * Phase 2a/2b/2c rules (§3, §5, §11):
 *   - No due date → 'list' surface (phase 2c list item)
 *   - Recurring with due date → chore with isRecurring=true (§5 rolling-occurrence model)
 *   - Non-recurring with due date → chore, occurrence_date=due.date
 */
export function surface(task: RawTask): SurfaceResult {
  if (!task.due) {
    return { kind: 'list' };
  }

  // Phase 2b: recurring tasks are handled via rolling-occurrence model (§5).
  // occurrenceDate = the current due.date (the active occurrence).
  return {
    kind: 'chore',
    occurrenceDate: task.due.date, // YYYY-MM-DD
    isRecurring: task.due.is_recurring,
  };
}

// ---------------------------------------------------------------------------
// occurrenceDate(): derive a frame-local occurrence date for a task
// ---------------------------------------------------------------------------

/**
 * Return the frame-local occurrence date for a task (YYYY-MM-DD).
 * For recurring tasks this is the task's current due date.
 * For non-recurring tasks it is the same.
 *
 * IMPORTANT (§10): always use task.due.date, NOT new Date() local — the
 * due date is the Todoist source of truth for the current occurrence, and
 * avoids the 06-18-vs-06-17 boundary bug.
 */
export function occurrenceDate(task: RawTask): string {
  return task.due?.date ?? '';
}

// ---------------------------------------------------------------------------
// fingerprint(): stable hash of content + due
// ---------------------------------------------------------------------------

/**
 * Compute a stable content fingerprint for a task.
 * This is stored as last_pushed_hash and compared on subsequent runs to
 * detect content/due changes that need a Skylight update.
 *
 * Format: "<content>|<due.date>|<profile>" — deterministic, no I/O.
 * Note: In production the hash could be SHA-256; for pure testability we use
 * a simple concatenation. The caller can upgrade to SHA-256 in index.ts if needed.
 */
export function fingerprint(task: RawTask, profile: string): string {
  const dueDate = task.due?.date ?? '';
  const content = task.content ?? '';
  return `${content}|${dueDate}|${profile}`;
}

// ---------------------------------------------------------------------------
// Carrier check (mirrors deck.ts / feed.ts)
// ---------------------------------------------------------------------------

const CARRIER_LABELS = new Set(['FP-item', 'FP-config', 'FP-charter']);

export function isCarrier(labels: string[]): boolean {
  return labels.some((l) => CARRIER_LABELS.has(l));
}

// ---------------------------------------------------------------------------
// fp_stable_id extraction
// ---------------------------------------------------------------------------

/**
 * Extract the FairPlay stable id from a task's FP:: metadata, if present.
 */
export function extractFpStableId(task: RawTask): string | null {
  const { meta } = parseFp(task.description ?? '');
  const id = meta['id'];
  if (typeof id === 'string' && id.length > 0) return id;
  return null;
}

/**
 * Extract the profile from a task's FP:: metadata, if present.
 */
export function extractFpProfile(task: RawTask): string | null {
  const { meta } = parseFp(task.description ?? '');
  const profile = meta['profile'];
  if (typeof profile === 'string' && profile.length > 0) return profile;
  return null;
}

// ---------------------------------------------------------------------------
// decide(): the core decision function
// ---------------------------------------------------------------------------

/**
 * Inputs:
 *   task          - The current Todoist task (authoritative for content/due)
 *   row           - The D1 mapping row (null if not yet mapped)
 *   observedChore - The live Skylight chore (null if not yet created, or 404)
 *   frameId       - The frame we're syncing against
 *   profile       - 'amy' | 'kyle'
 *   observedFetched - Whether observedChore was actually fetched (GET performed).
 *                    When false, null means "not fetched" (outbound pass — no per-id GET).
 *                    When true, null means confirmed 404 (inbound pass — GET returned 404).
 *                    IMPORTANT: only treat null as 404 → DELETE_CHORE when observedFetched=true.
 *                    Defaults to true for backwards compatibility with callers that always pass
 *                    a real GET result (inbound pass and tests that use actual chore GETs).
 *
 * Returns an ordered array of ReconcileActions for the caller to execute.
 * Returns [] (empty) for no-op.
 * PURE — no I/O, no side effects.
 */
export function decide(
  task: RawTask,
  row: MappingRow | null,
  observedChore: ChoreResource | null,
  frameId: string,
  profile: string,
  observedFetched = true
): ReconcileAction[] {
  // ── Phase 2a/2b/2c guards ─────────────────────────────────────────────────

  // Skip carrier tasks
  if (isCarrier(task.labels)) {
    return [{ type: 'NOOP' }];
  }

  // Classify surface
  const surf = surface(task);

  // skip_recurring is no longer produced by surface() in phase 2b — kept for
  // defensive exhaustiveness only (unreachable in practice).
  if (surf.kind === 'skip_recurring') {
    return [{ type: 'SKIP_RECURRING', reason: surf.reason }];
  }

  // ── Phase 2c: List surface ────────────────────────────────────────────────
  if (surf.kind === 'list') {
    return decideListSurface(task, row, frameId, profile);
  }

  // surf.kind === 'chore' from here

  // ── Surface migration: list row exists but task now has due date → chore ──
  if (row && row.surface === 'list' && surf.kind === 'chore') {
    return [{ type: 'MIGRATE_SURFACE', fromSurface: 'list', toSurface: 'chore' }];
  }

  const { isRecurring } = surf;

  // ── Row exists with state='detached' → skip ───────────────────────────────
  if (row?.state === 'detached') {
    return [
      {
        type: 'SKIP_DETACHED',
        reason: `task ${task.id}: mapping is detached (on-device summary diverged). Manual review needed.`,
      },
    ];
  }

  // ── Row exists with state='needs_review' → skip ───────────────────────────
  if (row?.state === 'needs_review') {
    return [
      {
        type: 'SKIP_DETACHED',
        reason: `task ${task.id}: mapping needs_review. Manual review needed.`,
      },
    ];
  }

  // ── Frame guard on existing row ───────────────────────────────────────────
  if (row && row.frame_id !== frameId) {
    return [
      {
        type: 'SKIP_FRAME_MISMATCH',
        reason:
          `task ${task.id}: mapping.frame_id=${row.frame_id} != target frameId=${frameId}. ` +
          `Refusing write (cross-frame guard).`,
      },
    ];
  }

  // ── Profile guard on existing row ─────────────────────────────────────────
  if (row && row.profile !== profile) {
    return [
      {
        type: 'SKIP_FRAME_MISMATCH',
        reason:
          `task ${task.id}: mapping.profile=${row.profile} != current profile=${profile}. ` +
          `Refusing write (profile mismatch guard).`,
      },
    ];
  }

  // ── §5 Recurring task: outbound occurrence_date advance → ROLL_CHORE ────────
  // Check BEFORE the task.checked path: a recurring task whose due has advanced
  // (completion in Todoist/FairPlay directly) needs a roll regardless of checked state.
  // Guard: new occurrence_date STRICTLY > stored row.occurrence_date (no double-advance).
  if (
    isRecurring &&
    row &&
    row.state === 'active' &&
    row.skylight_id &&
    task.due !== null
  ) {
    const newOccDate = task.due.date;
    const storedOccDate = row.occurrence_date;
    if (storedOccDate !== '' && newOccDate > storedOccDate) {
      // Due advanced: delete old chore and create new occurrence
      return [{ type: 'ROLL_CHORE', newOccurrenceDate: newOccDate }];
    }
    // occurrence_date unchanged or equal → no roll (stale/ping-pong guard)
  }

  // ── Todoist task is completed (outbound) ──────────────────────────────────
  // NOTE: for recurring tasks, Todoist close ADVANCES the task (doesn't truly complete it).
  // task.checked should never be true for a recurring task in normal flow
  // (Todoist advances the due date instead of marking checked). But handle defensively.
  if (task.checked) {
    if (!row || !row.skylight_id) {
      // Nothing to do — task completed but never synced
      return [{ type: 'NOOP' }];
    }

    // §8 Inbound reopen check: even if Todoist is checked, if the device shows
    // 'pending' and we last pushed 'complete', the device has been reopened.
    // Re-assert Todoist truth (push complete to device again).
    if (
      observedChore !== null &&
      observedChore.attributes.status === 'pending' &&
      row.last_pushed_status === 'complete'
    ) {
      return [{ type: 'REOPEN_TODOIST' }];
    }

    // If we've already pushed complete, no further action needed
    if (row.last_pushed_status === 'complete') {
      return [{ type: 'NOOP' }];
    }

    // Outbound: complete the chore on Skylight
    return [{ type: 'COMPLETE_CHORE' }];
  }

  // ── No mapping row → CREATE ───────────────────────────────────────────────
  if (!row || row.state === 'creating') {
    // Only create if we don't already have an active skylight_id from a prior
    // interrupted 'creating' row with a known id
    if (row?.state === 'creating' && row.skylight_id) {
      // We have a partial row — commit it to active if verifiable
      // (This is handled in index.ts as a recovery path; here we just NOOP)
      return [{ type: 'NOOP' }];
    }
    return [{ type: 'CREATE_CHORE' }];
  }

  // ── Active row exists ─────────────────────────────────────────────────────
  if (row.state === 'active') {
    const currentHash = fingerprint(task, profile);

    // ── Inbound: check what the device observed ───────────────────────────
    // observedChore is from a per-id GET (never list-absence inference)
    if (observedChore !== null) {
      const observed = observedChore.attributes.status;
      const lastPushed = row.last_pushed_status ?? 'pending';

      // Echo guard (§8): only propagate if observed != last_pushed AND
      // observed != current Todoist truth.
      const todoistStatus = task.checked ? 'complete' : 'pending';
      const isEcho = observed === lastPushed;
      const alreadyMatchesTodoist = observed === todoistStatus;

      if (!isEcho && !alreadyMatchesTodoist) {
        if (observed === 'complete' && !task.checked) {
          // §5: For a recurring task, device completing the current occurrence
          // should advance Todoist (close = advance) then roll to the next occurrence.
          // For non-recurring tasks, just close Todoist normally.
          if (isRecurring) {
            return [{ type: 'CLOSE_AND_ROLL_TODOIST' }];
          }
          // Device completed non-recurring → close in Todoist
          return [{ type: 'CLOSE_TODOIST' }];
        }
        if (observed === 'pending' && task.checked) {
          // Device reopened but Todoist is closed → re-assert Todoist truth
          return [{ type: 'REOPEN_TODOIST' }];
        }
      }

      // Content/due hash changed → update chore (non-recurring only; recurring
      // occurrence_date advances are handled by ROLL_CHORE above)
      if (!isRecurring && currentHash !== row.last_pushed_hash) {
        const changes: Record<string, string> = {};
        if (task.content !== (row.expected_summary?.replace(/ ▸\w+$/, '') ?? '')) {
          changes['summary'] = task.content;
        }
        if (task.due?.date !== row.occurrence_date) {
          changes['start'] = task.due?.date ?? '';
        }
        if (Object.keys(changes).length > 0) {
          return [{ type: 'UPDATE_CHORE', changes }];
        }
      }

      return [{ type: 'NOOP' }];
    }

    // observedChore is null.
    // Only treat as confirmed 404 (→ DELETE_CHORE) when the caller actually fetched
    // the chore (observedFetched=true). The outbound pass calls decide() with null
    // for observedChore because it does NOT do per-id GETs — null there means
    // "not fetched", not "confirmed 404". Treating it as 404 would delete every
    // healthy active chore on the first outbound run (blocker fix §7A).
    if (!observedFetched) {
      // Outbound path: no GET was issued. No-op — let the inbound pass detect 404s.
      return [{ type: 'NOOP' }];
    }

    // observedFetched=true and observedChore is null → confirmed 404 (device-side delete)
    // §8: drop mapping, don't auto-recreate (no whack-a-mole), log
    return [{ type: 'DELETE_CHORE' }]; // caller will hard-delete the row
  }

  // ── Deleting row (in-progress delete from prior run) ────────────────────
  if (row.state === 'deleting') {
    // Resume delete protocol
    return [{ type: 'DELETE_CHORE' }];
  }

  return [{ type: 'NOOP' }];
}

// ---------------------------------------------------------------------------
// Phase 2c: decideListSurface — pure decision for no-due tasks (list surface)
// ---------------------------------------------------------------------------

/**
 * Pure decision for tasks classified as 'list' surface (no due date).
 * Called from decide() when surf.kind === 'list'.
 *
 * PURE — no I/O, no side effects.
 */
function decideListSurface(
  task: RawTask,
  row: MappingRow | null,
  frameId: string,
  profile: string
): ReconcileAction[] {
  // ── Row exists with state='detached' or 'needs_review' → skip ────────────
  if (row?.state === 'detached' || row?.state === 'needs_review') {
    return [{
      type: 'SKIP_DETACHED',
      reason: `task ${task.id}: list mapping is ${row.state}. Manual review needed.`,
    }];
  }

  // ── Frame guard ───────────────────────────────────────────────────────────
  if (row && row.frame_id !== frameId) {
    return [{
      type: 'SKIP_FRAME_MISMATCH',
      reason: `task ${task.id}: mapping.frame_id=${row.frame_id} != target frameId=${frameId}. Cross-frame guard.`,
    }];
  }

  // ── Profile guard ─────────────────────────────────────────────────────────
  if (row && row.profile !== profile) {
    return [{
      type: 'SKIP_FRAME_MISMATCH',
      reason: `task ${task.id}: mapping.profile=${row.profile} != current profile=${profile}. Profile mismatch guard.`,
    }];
  }

  // ── Surface migration: row exists with surface='chore' but task has no due → list ──
  if (row && row.surface === 'chore') {
    return [{ type: 'MIGRATE_SURFACE', fromSurface: 'chore', toSurface: 'list' }];
  }

  // ── Todoist task is completed ─────────────────────────────────────────────
  if (task.checked) {
    if (!row || !row.skylight_id) {
      // Task completed before we ever created an item — nothing to do
      return [{ type: 'NOOP' }];
    }
    if (row.last_pushed_status === 'completed') {
      return [{ type: 'NOOP' }];
    }
    return [{ type: 'COMPLETE_LIST_ITEM' }];
  }

  // ── No mapping row → CREATE ───────────────────────────────────────────────
  if (!row || row.state === 'creating') {
    if (row?.state === 'creating' && row.skylight_id) {
      // Partial row — recovery handled in index.ts; NOOP here
      return [{ type: 'NOOP' }];
    }
    return [{ type: 'CREATE_LIST_ITEM' }];
  }

  // ── Active list row ───────────────────────────────────────────────────────
  // (content changes for list items are not tracked — label is write-once for safety)
  return [{ type: 'NOOP' }];
}

// ---------------------------------------------------------------------------
// Inbound-only decide: for rows with no current Todoist task (task gone)
// ---------------------------------------------------------------------------

/**
 * Decide what to do when a mapped task is no longer in Todoist
 * (deleted or moved out of scope).
 * §9: delete protocol — re-GET, confirm, delete, confirm 404, hard-delete row.
 */
export function decideTaskGone(row: MappingRow): ReconcileAction[] {
  if (row.state === 'active' || row.state === 'deleting') {
    // For list rows: DELETE_LIST_ITEM; for chore rows: DELETE_CHORE
    if (row.surface === 'list') {
      return [{ type: 'DELETE_LIST_ITEM' }];
    }
    return [{ type: 'DELETE_CHORE' }];
  }
  // creating/needs_review/detached — just clean up the D1 row
  return [{ type: 'NOOP' }];
}
