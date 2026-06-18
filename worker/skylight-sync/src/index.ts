/**
 * Skylight Sync Worker — main entry point.
 *
 * Runs on a cron schedule (see wrangler.jsonc triggers.crons).
 * Implements the §7 sync algorithm, wiring together all modules.
 *
 * Thin orchestrator — pure logic lives in reconcile.ts, I/O in the clients.
 *
 * Startup sequence (§7):
 *   1. Acquire single-writer lease (else exit)
 *   2. Assert frame fingerprint (else hard-abort)
 *   3. Re-auth if Skylight token expired
 *   4. Outbound pass: Todoist → Skylight
 *   5. Inbound pass: Skylight → Todoist (per-id GETs)
 *   6. Release lease
 *
 * Safety guards enforced here:
 *   - FRAME_CONFIRMED check before any write (§9)
 *   - Write-ahead 'creating' row before POST (§9)
 *   - Create-then-verify-then-record (§9)
 *   - Delete protocol: re-GET → confirm → DELETE → confirm 404 → hard-delete (§9)
 *   - Read-back verify every write (§9)
 *   - Echo guard via last_pushed_status / last_pushed_hash (§8)
 *   - 401 → re-auth + retry once (§10)
 *   - 429 → bounded backoff then checkpoint-exit (§10)
 *   - Frame-timezone-aware date windows (§10)
 */

import type { Env, MappingRow } from './types.js';
import {
  SkylightClient,
  pkceAuth,
  buildSummary,
  sentinelToken,
  summaryMatchesSentinel,
  choreDescriptionMarker,
  descriptionMatchesMarker,
  SkylightApiError,
  FrameGuardError,
  ensureFairPlayList,
  BRIDGE_LIST_LABEL,
  DRYRUN_SYNTHETIC_LIST_ID,
  ListWriteGuardError,
} from './skylight-client.js';
import {
  fetchDeckTasks,
  closeTask,
  getTask,
  TodoistRateLimitError,
} from './todoist-client.js';
import {
  acquireLease,
  releaseLease,
  getMappingByTodoistId,
  getMappingsByTodoistId,
  getActiveMappings,
  getActiveMappingsBySurface,
  getDeletingMappings,
  insertCreatingRow,
  commitActiveRow,
  markNeedsReview,
  markDetached,
  updatePushedStatus,
  updateObservedStatus,
  markDeleting,
  hardDeleteRow,
  getReviewRows,
  rollOccurrenceDate,
} from './db.js';
import {
  surface,
  fingerprint,
  decide,
  decideTaskGone,
  occurrenceDate as getOccurrenceDate,
  isCarrier,
} from './reconcile.js';
import type { ProfileId } from './deck.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROFILES: ProfileId[] = ['kyle', 'amy'];

/** KV key for Skylight bearer token */
const KV_SKYLIGHT_TOKEN = 'skylight_token';
/** KV key for token expiry (Unix seconds as string) */
const KV_SKYLIGHT_TOKEN_EXP = 'skylight_token_exp';
/** Window around occurrence_date for chore list queries (days) */
const WINDOW_DAYS_PAST = 30;
const WINDOW_DAYS_FUTURE = 90;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the label for a bridge list item.
 * Returns the CLEAN task content with NO visible sentinel.
 *
 * Ownership for list items rests on (a) the id-map (we only ever PUT/DELETE
 * list_item ids we created + recorded) AND (b) the dedicated bridge-owned
 * "▸ FairPlay" list (assertBridgeListWrite already enforces this).
 * There is no hidden field on list_items, so no marker can be stored server-side.
 */
export function buildListItemLabel(content: string, _todoistId: string): string {
  return content;
}

/** Get a frame-timezone-aware ISO date string (YYYY-MM-DD). */
function frameLocalDate(timezone: string, offsetDays = 0): string {
  const now = new Date();
  const frameDate = new Date(
    now.toLocaleString('en-US', { timeZone: timezone })
  );
  frameDate.setDate(frameDate.getDate() + offsetDays);
  return frameDate.toISOString().slice(0, 10);
}

/** Parse the profile→categoryId map from env. */
function parseProfileCategoryMap(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through
  }
  console.warn('[skylight-sync] PROFILE_CATEGORY_MAP parse failed — using empty map');
  return {};
}

// ---------------------------------------------------------------------------
// Skylight token management
// ---------------------------------------------------------------------------

async function getSkylightToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expStr = await env.KV.get(KV_SKYLIGHT_TOKEN_EXP);
  const exp = expStr ? parseInt(expStr, 10) : 0;

  if (exp > now + 60) {
    const token = await env.KV.get(KV_SKYLIGHT_TOKEN);
    if (token) return token;
  }

  // Re-auth
  console.log('[skylight-sync] Skylight token expired or missing — re-authenticating');
  const token = await pkceAuth(env.SKYLIGHT_EMAIL, env.SKYLIGHT_PASSWORD);

  // Store token with 55-minute TTL (tokens are typically 1 hour)
  await env.KV.put(KV_SKYLIGHT_TOKEN, token, { expirationTtl: 3300 });
  await env.KV.put(KV_SKYLIGHT_TOKEN_EXP, String(now + 3300));

  return token;
}

// ---------------------------------------------------------------------------
// Delete protocol (§9)
// ---------------------------------------------------------------------------

export async function runDeleteProtocol(
  client: SkylightClient,
  db: D1Database,
  row: MappingRow,
  dryrun = false
): Promise<void> {
  const { todoist_id, occurrence_date, skylight_id, expected_summary } = row;

  if (!skylight_id) {
    console.log(
      `[skylight-sync] delete-protocol: row ${todoist_id}/${occurrence_date} has no skylight_id — hard-deleting D1 row`
    );
    await hardDeleteRow(db, todoist_id, occurrence_date, dryrun);
    return;
  }

  // Step 1: re-GET by id via list — confirm exists + carries our ownership marker in description
  const live = await client.getChoreById(skylight_id, occurrence_date);

  if (live === null) {
    // Already gone — just hard-delete D1 row
    console.log(
      `[skylight-sync] delete-protocol: chore ${skylight_id} already 404 — hard-deleting D1 row`
    );
    await hardDeleteRow(db, todoist_id, occurrence_date, dryrun);
    return;
  }

  // §9: Confirm the live chore carries our ownership marker in description.
  // The marker is deterministic: choreDescriptionMarker(todoist_id) = "FPSYNC|<todoist_id>".
  const expectedDescMarker = choreDescriptionMarker(todoist_id);
  if (!descriptionMatchesMarker(live.attributes.description, expectedDescMarker)) {
    console.error(
      `[skylight-sync] delete-protocol ABORT: chore ${skylight_id} description marker mismatch. ` +
        `Expected: "${expectedDescMarker}", got: "${live.attributes.description}". ` +
        `Marking detached — manual review needed.`
    );
    await markDetached(db, todoist_id, occurrence_date, dryrun);
    return;
  }

  if (dryrun) {
    console.log(`[skylight-sync] DRYRUN: would DELETE chore ${skylight_id}`);
    return;
  }

  // Step 2: mark deleting in D1 before the HTTP call
  await markDeleting(db, todoist_id, occurrence_date);

  // Step 3: DELETE (one-time, no apply_to)
  await client.deleteChore(skylight_id);

  // Step 4: confirm deletion (absent from list)
  await client.verifyDeleted(skylight_id, occurrence_date);

  // Step 5: hard-delete D1 row
  await hardDeleteRow(db, todoist_id, occurrence_date);
  console.log(
    `[skylight-sync] delete-protocol: chore ${skylight_id} deleted and confirmed 404. D1 row hard-deleted.`
  );
}

// ---------------------------------------------------------------------------
// Roll protocol (§5) — delete old occurrence chore and create the new one
//
// Called both from the outbound pass (Todoist due advanced directly) and from
// the inbound pass (device completed → Todoist close advanced the due → roll).
//
// Safety: uses the existing delete protocol + create protocol, fully DRYRUN-gated.
// ---------------------------------------------------------------------------

export async function runRollProtocol(
  client: SkylightClient,
  db: D1Database,
  oldRow: MappingRow,
  newOccurrenceDate: string,
  task: { id: string; content: string; due: { date: string } | null; description: string; labels: string[] },
  frameId: string,
  profile: string,
  categoryId: string | null,
  timezone: string,
  dryrun = false
): Promise<void> {
  const { todoist_id, occurrence_date: oldOccDate } = oldRow;

  console.log(
    `[skylight-sync] roll-protocol: task ${todoist_id} occurrence ${oldOccDate} → ${newOccurrenceDate}`
  );

  // Step 1: §9 delete the old occurrence chore (re-GET, confirm, DELETE, confirm 404)
  await runDeleteProtocol(client, db, oldRow, dryrun);

  // After delete, the old row is hard-deleted. Now register the new occurrence in D1
  // and create the Skylight chore for it.

  // Step 2: check whether a 'creating' row for the new occurrence already exists
  // (e.g., from an interrupted prior roll — idempotent resume).
  // Under DRYRUN, no row was written, so this will always return null; that is correct.
  const { getMappingByTodoistId: getMapping } = await import('./db.js');
  const existingNew = await getMapping(db, todoist_id, newOccurrenceDate);

  // Step 3: create the new occurrence chore (write-ahead + POST + read-back + commit)
  await runCreateProtocol(
    client,
    db,
    { ...task, due: { date: newOccurrenceDate } },
    existingNew,
    frameId,
    profile,
    newOccurrenceDate,
    categoryId,
    timezone,
    dryrun
  );

  console.log(
    `[skylight-sync] roll-protocol: completed roll from ${oldOccDate} → ${newOccurrenceDate} for task ${todoist_id}`
  );
}

// ---------------------------------------------------------------------------
// Orphan sweep: resume or clean up stale 'deleting' rows (major fix §9)
//
// If a prior run died after the Skylight DELETE+verify but before hardDeleteRow,
// the row is stuck in state='deleting' with a now-404 skylight_id. On re-run,
// getActiveMappings() only returns state='active', so the orphan is never visited.
//
// This sweep loads all 'deleting' rows and for each one:
//   - If the Skylight chore is already 404 → hard-delete the D1 row (clean up).
//   - If the Skylight chore still exists → run full delete protocol (resume).
// ---------------------------------------------------------------------------

export async function runOrphanSweep(
  client: SkylightClient,
  db: D1Database,
  frameId: string,
  dryrun = false
): Promise<void> {
  const deletingRows = await getDeletingMappings(db);
  if (deletingRows.length === 0) return;

  console.log(`[skylight-sync] orphan-sweep: ${deletingRows.length} stale 'deleting' row(s) found`);

  for (const row of deletingRows) {
    // Frame guard: only process rows belonging to the running frame
    if (row.frame_id !== frameId) {
      console.warn(
        `[skylight-sync] orphan-sweep: skipping row ${row.todoist_id}/${row.occurrence_date} — ` +
          `frame_id=${row.frame_id} != running frameId=${frameId}`
      );
      continue;
    }

    if (!row.skylight_id) {
      // No skylight_id — just hard-delete the orphan row
      console.log(
        `[skylight-sync] orphan-sweep: row ${row.todoist_id}/${row.occurrence_date} has no skylight_id — hard-deleting`
      );
      await hardDeleteRow(db, row.todoist_id, row.occurrence_date, dryrun);
      continue;
    }

    try {
      const live = await client.getChoreById(row.skylight_id, row.occurrence_date);
      if (live === null) {
        // Chore already gone — just clean up the D1 row
        console.log(
          `[skylight-sync] orphan-sweep: chore ${row.skylight_id} is gone — hard-deleting orphan D1 row`
        );
        await hardDeleteRow(db, row.todoist_id, row.occurrence_date, dryrun);
      } else {
        // Chore still exists — resume the delete protocol (re-GET, confirm, DELETE, confirm gone, hard-delete)
        console.log(
          `[skylight-sync] orphan-sweep: chore ${row.skylight_id} still exists — resuming delete protocol`
        );
        await runDeleteProtocol(client, db, row, dryrun);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[skylight-sync] orphan-sweep: error processing row ${row.todoist_id}/${row.occurrence_date}: ${msg}`
      );
      // Continue — idempotent on next run
    }
  }
}

// ---------------------------------------------------------------------------
// Outbound pass: Todoist → Skylight
// ---------------------------------------------------------------------------

export async function runOutboundPass(
  client: SkylightClient,
  db: D1Database,
  env: Env,
  frameId: string,
  profile: ProfileId,
  categoryId: string | null,
  timezone: string,
  bridgeListId?: string
): Promise<void> {
  console.log(`[skylight-sync] outbound: profile=${profile}`);

  const tasks = await fetchDeckTasks(profile, env.TODOIST_API_TOKEN);
  console.log(`[skylight-sync] outbound: ${tasks.length} deck tasks for ${profile}`);

  const dryrun = (env.DRYRUN ?? 'true') !== 'false';

  for (const task of tasks) {
    try {
      const surf = surface(task);

      // skip_recurring is no longer emitted by surface() in phase 2b
      if (surf.kind === 'skip_recurring') {
        console.log(`[skylight-sync] skip (recurring): ${task.id} "${task.content}"`);
        continue;
      }

      // ── Phase 2c: no-due tasks → list surface ──────────────────────────────
      if (surf.kind === 'list') {
        if (!bridgeListId) {
          console.log(`[skylight-sync] skip (no due, bridge list not ready): ${task.id} "${task.content}"`);
          continue;
        }
        // Get existing mapping (occurrence_date='' for list items)
        const row = await getMappingByTodoistId(db, task.id, '');

        // ── Surface migration dispatch (chore→list): task LOST its due date ──
        // The list-keyed lookup above returns null when the old row is a chore
        // (keyed by occurrence_date != ''). Load all rows and look for an active
        // chore row; if found, migrate it instead of creating a duplicate list item.
        if (!row) {
          const allRows = await getMappingsByTodoistId(db, task.id);
          const oldChoreRow = allRows.find(
            (r) => r.state === 'active' && r.surface === 'chore' && r.frame_id === frameId
          );
          if (oldChoreRow) {
            console.log(
              `[skylight-sync] outbound: task ${task.id} lost its due date — migrating chore→list`
            );
            await runMigrateSurfaceProtocol(
              client, db, oldChoreRow, task, 'chore', 'list',
              frameId, profile, categoryId, bridgeListId, dryrun, timezone
            );
            continue;
          }
        }

        const actions = decide(task, row, null, frameId, profile, false);

        for (const action of actions) {
          switch (action.type) {
            case 'CREATE_LIST_ITEM': {
              await runCreateListItemProtocol(client, db, task, row, frameId, profile, bridgeListId, dryrun);
              break;
            }
            case 'COMPLETE_LIST_ITEM': {
              if (!row?.skylight_id) break;
              await runCompleteListItemProtocol(client, db, row, bridgeListId, dryrun);
              break;
            }
            case 'DELETE_LIST_ITEM': {
              if (!row) break;
              await runDeleteListItemProtocol(client, db, row, bridgeListId, dryrun);
              break;
            }
            case 'MIGRATE_SURFACE': {
              if (!row) break;
              await runMigrateSurfaceProtocol(
                client, db, row, task, action.fromSurface, action.toSurface,
                frameId, profile, categoryId, bridgeListId, dryrun, timezone
              );
              break;
            }
            case 'NOOP':
            case 'SKIP_DETACHED':
            case 'SKIP_FRAME_MISMATCH':
              break;
            default:
              break;
          }
        }
        continue;
      }

      const curOccurrenceDate = surf.occurrenceDate;
      // §5 Recurring tasks: the row is keyed by the CURRENT occurrence_date.
      // Also check for any existing row for THIS todoist_id (across occurrence_dates)
      // in case the occurrence_date changed since we last synced.
      let row = await getMappingByTodoistId(db, task.id, curOccurrenceDate);

      // ── Surface migration dispatch (list→chore): task GAINED a due date ──
      // The chore-keyed lookup above returns null when the old row is a list item
      // (keyed at occurrence_date=''). Load all rows and look for an active list
      // row; if found, migrate it instead of creating a duplicate chore.
      if (!row) {
        const allRowsForMigrate = await getMappingsByTodoistId(db, task.id);
        const oldListRow = allRowsForMigrate.find(
          (r) => r.state === 'active' && r.surface === 'list' && r.frame_id === frameId
        );
        if (oldListRow) {
          console.log(
            `[skylight-sync] outbound: task ${task.id} gained a due date — migrating list→chore`
          );
          const effectiveBridgeListId = bridgeListId ?? '';
          await runMigrateSurfaceProtocol(
            client, db, oldListRow, task, 'list', 'chore',
            frameId, profile, categoryId, effectiveBridgeListId, dryrun, timezone
          );
          continue;
        }
      }

      // §5 For recurring tasks: if no row found for the CURRENT occurrence_date,
      // look for an existing row for this todoist_id with an older occurrence_date.
      // If found and occurrence_date strictly < curOccurrenceDate, we have a roll situation.
      if (!row && surf.isRecurring) {
        const allRows = await getMappingsByTodoistId(db, task.id);
        const activeOldRow = allRows.find(
          (r) =>
            r.state === 'active' &&
            r.occurrence_date !== '' &&
            r.occurrence_date < curOccurrenceDate
        );
        if (activeOldRow) {
          console.log(
            `[skylight-sync] outbound: recurring task ${task.id} due advanced ` +
              `from ${activeOldRow.occurrence_date} → ${curOccurrenceDate} — rolling`
          );
          await runRollProtocol(
            client, db, activeOldRow, curOccurrenceDate,
            task, frameId, profile, categoryId, timezone, dryrun
          );
          continue;
        }
      }

      // observedFetched=false: the outbound pass does NOT do per-id GET calls.
      // null here means "not fetched", not "confirmed 404". Passing false prevents
      // decide() from treating every in-sync active row as a 404→DELETE_CHORE (blocker fix).
      // Device-side 404 detection is the inbound pass's responsibility (per-id GET).
      const actions = decide(task, row, null /* not fetched */, frameId, profile, false);

      for (const action of actions) {
        switch (action.type) {
          case 'CREATE_CHORE': {
            await runCreateProtocol(client, db, task, row, frameId, profile, curOccurrenceDate, categoryId, timezone, dryrun);
            break;
          }
          case 'COMPLETE_CHORE': {
            if (!row?.skylight_id) break;
            await runCompleteProtocol(client, db, row, dryrun);
            break;
          }
          case 'DELETE_CHORE': {
            if (!row) break;
            await runDeleteProtocol(client, db, row, dryrun);
            break;
          }
          case 'ROLL_CHORE': {
            // §5: outbound roll — Todoist due advanced while row was keyed by old date
            if (!row) break;
            await runRollProtocol(
              client, db, row, action.newOccurrenceDate,
              task, frameId, profile, categoryId, timezone, dryrun
            );
            break;
          }
          case 'UPDATE_CHORE': {
            // Phase 2a/2b: content updates are logged but not yet implemented
            // (requires a proven PUT shape for summary/start updates)
            console.log(
              `[skylight-sync] UPDATE_CHORE for ${task.id} — logged, not yet implemented`
            );
            break;
          }
          case 'MIGRATE_SURFACE': {
            // Task that had a list row now has a due date → chore
            if (!row) break;
            const effectiveBridgeListId = bridgeListId ?? '';
            await runMigrateSurfaceProtocol(
              client, db, row, task, action.fromSurface, action.toSurface,
              frameId, profile, categoryId, effectiveBridgeListId, dryrun, timezone
            );
            break;
          }
          case 'NOOP':
            break;
          case 'SKIP_NO_DUE':
          case 'SKIP_RECURRING':
            console.log(`[skylight-sync] ${action.type}: ${action.reason}`);
            break;
          case 'SKIP_DETACHED':
          case 'SKIP_FRAME_MISMATCH':
            console.warn(`[skylight-sync] ${action.type}: ${action.reason}`);
            break;
          case 'CLOSE_AND_ROLL_TODOIST':
          case 'CLOSE_TODOIST':
          case 'REOPEN_TODOIST':
            // These are inbound actions only — should not appear in outbound pass
            break;
          case 'CREATE_LIST_ITEM':
          case 'COMPLETE_LIST_ITEM':
          case 'DELETE_LIST_ITEM':
            // These are list surface actions — handled above in the surf.kind === 'list' branch
            break;
        }
      }
    } catch (err) {
      if (err instanceof TodoistRateLimitError) {
        console.error(`[skylight-sync] 429 exhausted in outbound pass — checkpointing`);
        throw err; // propagate to top-level handler for clean exit
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[skylight-sync] outbound error for task ${task.id}: ${msg}`);
      // Continue with next task — idempotent resume
    }
  }
}

// ---------------------------------------------------------------------------
// Create protocol (§9 write-ahead + verify)
// ---------------------------------------------------------------------------

export async function runCreateProtocol(
  client: SkylightClient,
  db: D1Database,
  task: { id: string; content: string; due: { date: string } | null; description: string; labels: string[] },
  existingRow: MappingRow | null,
  frameId: string,
  profile: string,
  occurrenceDate: string,
  categoryId: string | null,
  timezone: string,
  dryrun = false
): Promise<void> {
  // §9 clean-title scheme: summary = clean task content (no sentinel).
  // Ownership marker goes in attributes.description = "FPSYNC|<todoistId>".
  // idemToken retained for legacy compatibility but description marker is the real guard.
  const idemToken = sentinelToken(task.id);
  const cleanSummary = task.content;
  const descMarker = choreDescriptionMarker(task.id);
  const dueDate = task.due?.date ?? occurrenceDate;

  // expected_summary stored in the mapping row is the clean title (for display/reference).
  // Ownership verification uses descMarker (recomputable from todoist_id).
  const expectedSummary = cleanSummary;

  // If an existing 'creating' row has a confirmed skylight_id, just try to promote it
  if (existingRow?.state === 'creating' && existingRow.skylight_id) {
    console.log(
      `[skylight-sync] create-protocol: row ${task.id}/${occurrenceDate} already has skylight_id=${existingRow.skylight_id} in 'creating' state — attempting promotion`
    );
    const readback = await client.getChoreById(existingRow.skylight_id, occurrenceDate);
    if (readback && descriptionMatchesMarker(readback.attributes.description, descMarker)) {
      const hash = fingerprint(
        { id: task.id, content: task.content, due: task.due, description: task.description, labels: task.labels, project_id: '', section_id: null, parent_id: null, priority: 1, checked: false } as import('./types.js').RawTask,
        profile
      );
      await commitActiveRow(db, task.id, occurrenceDate, existingRow.skylight_id, expectedSummary, hash, dryrun);
      console.log(
        `[skylight-sync] create-protocol: promoted existing skylight_id=${existingRow.skylight_id} to active`
      );
    } else {
      console.warn(
        `[skylight-sync] create-protocol: skylight_id=${existingRow.skylight_id} missing or description marker mismatch — marking needs_review`
      );
      await markNeedsReview(db, task.id, occurrenceDate, dryrun);
    }
    return;
  }

  // §9 write-ahead recovery: if 'creating' row has null skylight_id, search for an already-created
  // chore by description marker (§9: read-back-by-marker, never blind re-create).
  // Under DRYRUN no row was written so existingRow will always be null here; skip the scan.
  if (!dryrun && existingRow?.state === 'creating' && !existingRow.skylight_id) {
    console.log(
      `[skylight-sync] create-protocol: interrupted create for ${task.id}/${occurrenceDate} — scanning for existing chore by description marker`
    );
    const after = frameLocalDate(timezone, -WINDOW_DAYS_PAST);
    const before = frameLocalDate(timezone, WINDOW_DAYS_FUTURE);
    const chores = await client.listChores(after, before);
    const existing = chores.find((c) => descriptionMatchesMarker(c.attributes.description, descMarker));
    if (existing) {
      console.log(
        `[skylight-sync] create-protocol: found existing chore ${existing.id} by description marker — adopting (no re-POST)`
      );
      const hash = fingerprint(
        { id: task.id, content: task.content, due: task.due, description: task.description, labels: task.labels, project_id: '', section_id: null, parent_id: null, priority: 1, checked: false } as import('./types.js').RawTask,
        profile
      );
      await commitActiveRow(db, task.id, occurrenceDate, existing.id, expectedSummary, hash);
      return;
    }
    console.log(
      `[skylight-sync] create-protocol: no existing chore found by description marker — proceeding with POST`
    );
  }

  if (dryrun) {
    // DRYRUN: log the planned create and return without touching D1 or Skylight
    console.log(`[skylight-sync] DRYRUN: would create chore for task ${task.id} (summary="${cleanSummary}", description="${descMarker}")`);
    return;
  }

  // §9: write-ahead 'creating' row BEFORE the POST
  if (!existingRow) {
    const { meta } = (await import('./metadata.js')).parseFp(task.description ?? '');
    const fpStableId = typeof meta['id'] === 'string' ? meta['id'] : null;

    await insertCreatingRow(db, {
      todoist_id: task.id,
      fp_stable_id: fpStableId,
      occurrence_date: occurrenceDate,
      surface: 'chore',
      frame_id: frameId,
      profile,
      skylight_id: null,
      expected_summary: expectedSummary,
      last_pushed_status: null,
      observed_status: null,
      last_pushed_hash: null,
      state: 'creating',
      idem_token: idemToken,
    });
  }

  // POST the chore — clean summary, ownership marker in description
  const created = await client.createChore({
    summary: cleanSummary,
    start: dueDate,
    categoryId,
    idemToken,
    description: descMarker,
  });

  const skylightId = created.id;

  // §9: read-back via list to confirm
  const readback = await client.getChoreById(skylightId, dueDate);
  if (!readback) {
    console.error(
      `[skylight-sync] create-protocol: read-back 404 for ${skylightId} — marking needs_review`
    );
    await markNeedsReview(db, task.id, occurrenceDate);
    return;
  }

  // §9: assert description marker echoed back (ownership verification)
  if (!descriptionMatchesMarker(readback.attributes.description, descMarker)) {
    console.error(
      `[skylight-sync] create-protocol: read-back description mismatch for ${skylightId}. ` +
        `Expected: "${descMarker}", got: "${readback.attributes.description}". Marking needs_review.`
    );
    await markNeedsReview(db, task.id, occurrenceDate);
    return;
  }

  // §9: assert start date matches
  if (readback.attributes.start !== dueDate) {
    console.warn(
      `[skylight-sync] create-protocol: start date mismatch for ${skylightId}. ` +
        `Expected: "${dueDate}", got: "${readback.attributes.start}". Committing anyway (Skylight may normalize dates).`
    );
  }

  // Commit to 'active' — expected_summary is the clean title
  const hash = fingerprint(
    { id: task.id, content: task.content, due: task.due, description: task.description, labels: task.labels, project_id: '', section_id: null, parent_id: null, priority: 1, checked: false } as import('./types.js').RawTask,
    profile
  );

  await commitActiveRow(db, task.id, occurrenceDate, skylightId, expectedSummary, hash);
  console.log(
    `[skylight-sync] create-protocol: chore ${skylightId} created and verified for task ${task.id} (clean title, description marker="${descMarker}")`
  );
}

// ---------------------------------------------------------------------------
// Complete protocol (§9 read-back verify)
// ---------------------------------------------------------------------------

export async function runCompleteProtocol(
  client: SkylightClient,
  db: D1Database,
  row: MappingRow,
  dryrun = false
): Promise<void> {
  if (!row.skylight_id) return;

  // Step 1: re-GET via list — confirm exists + carries our ownership marker in description.
  // Mirrors runDeleteProtocol: we must not complete a chore we don't own.
  const live = await client.getChoreById(row.skylight_id, row.occurrence_date);

  if (live === null) {
    // Chore already gone — nothing to complete; detach the D1 row.
    console.log(
      `[skylight-sync] complete-protocol: chore ${row.skylight_id} already 404 — marking detached`
    );
    await markDetached(db, row.todoist_id, row.occurrence_date, dryrun);
    return;
  }

  // §9: Confirm the live chore carries our ownership marker in description.
  const expectedDescMarker = choreDescriptionMarker(row.todoist_id);
  if (!descriptionMatchesMarker(live.attributes.description, expectedDescMarker)) {
    console.error(
      `[skylight-sync] complete-protocol ABORT: chore ${row.skylight_id} description marker mismatch. ` +
        `Expected: "${expectedDescMarker}", got: "${live.attributes.description}". ` +
        `Marking detached — manual review needed.`
    );
    await markDetached(db, row.todoist_id, row.occurrence_date, dryrun);
    return;
  }

  if (dryrun) {
    console.log(`[skylight-sync] DRYRUN: would complete chore ${row.skylight_id}`);
    return;
  }

  await client.completeChore(row.skylight_id);

  // §9: read-back verify status flipped (via list)
  await client.verifyCompleted(row.skylight_id, row.occurrence_date);

  await updatePushedStatus(db, row.todoist_id, row.occurrence_date, 'complete');
  console.log(
    `[skylight-sync] complete-protocol: chore ${row.skylight_id} completed and verified`
  );
}

// ---------------------------------------------------------------------------
// Phase 2c: List item create protocol
// ---------------------------------------------------------------------------

/**
 * Create a list item in the dedicated bridge list for a no-due Todoist task.
 *
 * Write-ahead: inserts 'creating' row (surface='list', occurrence_date='') BEFORE the POST.
 * Post-create: reads back the item from GET /lists/{listId} to confirm it exists.
 * Commits to 'active' with the returned item id.
 *
 * DRYRUN: logs the planned action, makes zero D1 writes, returns immediately.
 */
export async function runCreateListItemProtocol(
  client: SkylightClient,
  db: D1Database,
  task: { id: string; content: string; description: string; labels: string[] },
  existingRow: MappingRow | null,
  frameId: string,
  profile: string,
  bridgeListId: string,
  dryrun: boolean
): Promise<void> {
  const label = buildListItemLabel(task.content, task.id);
  const occDate = ''; // list items have no due date

  // Skip if already active
  if (existingRow?.state === 'active' && existingRow.skylight_id) {
    return;
  }

  if (dryrun) {
    console.log(`[skylight-sync] DRYRUN: would create list item for task ${task.id} in list ${bridgeListId}`);
    return;
  }

  // §9: write-ahead 'creating' row BEFORE the POST
  if (!existingRow) {
    await insertCreatingRow(db, {
      todoist_id: task.id,
      fp_stable_id: null,
      occurrence_date: occDate,
      surface: 'list',
      frame_id: frameId,
      profile,
      skylight_id: null,
      expected_summary: label,
      last_pushed_status: null,
      observed_status: null,
      last_pushed_hash: null,
      state: 'creating',
      idem_token: sentinelToken(task.id),
    });
  }

  // POST the list item
  const created = await client.createListItem(bridgeListId, label, bridgeListId);

  const itemId = created.id;

  // Read-back verify: GET the list to confirm item exists
  const items = await client.getListItems(bridgeListId);
  const readback = items.find((i) => i.id === itemId);

  if (!readback) {
    console.error(
      `[skylight-sync] create-list-item-protocol: read-back failed for item ${itemId} in list ${bridgeListId} — marking needs_review`
    );
    await markNeedsReview(db, task.id, occDate);
    return;
  }

  // Commit to 'active' — use itemId as skylight_id; label as expected_summary
  await commitActiveRow(db, task.id, occDate, itemId, label, task.id);
  console.log(
    `[skylight-sync] create-list-item-protocol: item ${itemId} created for task ${task.id}`
  );
}

// ---------------------------------------------------------------------------
// Phase 2c: List item complete protocol
// ---------------------------------------------------------------------------

/**
 * Complete a list item on Skylight when the Todoist task is completed.
 * PUT {status:"completed"} (note: "completed" not "complete").
 * Read-back verify: GET the list and confirm status='completed'.
 * DRYRUN: no PUT.
 */
export async function runCompleteListItemProtocol(
  client: SkylightClient,
  db: D1Database,
  row: MappingRow,
  bridgeListId: string,
  dryrun: boolean
): Promise<void> {
  if (!row.skylight_id) return;
  const occDate = row.occurrence_date; // '' for list items

  if (dryrun) {
    console.log(`[skylight-sync] DRYRUN: would complete list item ${row.skylight_id}`);
    return;
  }

  await client.completeListItem(bridgeListId, row.skylight_id, bridgeListId);

  // Read-back verify
  const items = await client.getListItems(bridgeListId);
  const readback = items.find((i) => i.id === row.skylight_id);

  if (!readback) {
    console.error(
      `[skylight-sync] complete-list-item-protocol: item ${row.skylight_id} not found after PUT — marking needs_review`
    );
    await markNeedsReview(db, row.todoist_id, occDate);
    return;
  }

  if (readback.attributes.status !== 'completed') {
    console.error(
      `[skylight-sync] complete-list-item-protocol: item ${row.skylight_id} status="${readback.attributes.status}" after PUT (silent no-op?) — marking needs_review`
    );
    await markNeedsReview(db, row.todoist_id, occDate);
    return;
  }

  await updatePushedStatus(db, row.todoist_id, occDate, 'complete');
  console.log(
    `[skylight-sync] complete-list-item-protocol: item ${row.skylight_id} completed and verified`
  );
}

// ---------------------------------------------------------------------------
// Phase 2c: List item delete protocol
// ---------------------------------------------------------------------------

/**
 * Delete a list item from the bridge list.
 * DELETE then read-back to confirm item is gone (not in list items).
 * DRYRUN: no DELETE.
 */
export async function runDeleteListItemProtocol(
  client: SkylightClient,
  db: D1Database,
  row: MappingRow,
  bridgeListId: string,
  dryrun: boolean
): Promise<void> {
  const { todoist_id, occurrence_date, skylight_id } = row;

  if (!skylight_id) {
    console.log(
      `[skylight-sync] delete-list-item-protocol: row ${todoist_id} has no skylight_id — hard-deleting D1 row`
    );
    await hardDeleteRow(db, todoist_id, occurrence_date, dryrun);
    return;
  }

  if (dryrun) {
    console.log(`[skylight-sync] DRYRUN: would DELETE list item ${skylight_id}`);
    return;
  }

  // Step 1: verify item exists (confirm before delete)
  const itemsBefore = await client.getListItems(bridgeListId);
  const itemExists = itemsBefore.some((i) => i.id === skylight_id);

  if (!itemExists) {
    // Already gone — just hard-delete D1 row
    console.log(
      `[skylight-sync] delete-list-item-protocol: item ${skylight_id} already gone — hard-deleting D1 row`
    );
    await hardDeleteRow(db, todoist_id, occurrence_date);
    return;
  }

  // Step 2: DELETE
  await client.deleteListItem(bridgeListId, skylight_id, bridgeListId);

  // Step 3: confirm item is gone
  const itemsAfter = await client.getListItems(bridgeListId);
  const stillExists = itemsAfter.some((i) => i.id === skylight_id);

  if (stillExists) {
    console.error(
      `[skylight-sync] delete-list-item-protocol: item ${skylight_id} still exists after DELETE — marking needs_review`
    );
    await markNeedsReview(db, todoist_id, occurrence_date);
    return;
  }

  // Step 4: hard-delete D1 row
  await hardDeleteRow(db, todoist_id, occurrence_date);
  console.log(
    `[skylight-sync] delete-list-item-protocol: item ${skylight_id} deleted and confirmed. D1 row hard-deleted.`
  );
}

// ---------------------------------------------------------------------------
// Phase 2c: Surface migration protocol
// ---------------------------------------------------------------------------

/**
 * Handle surface migration: a task gained or lost a due date since last sync.
 *
 * fromSurface='list', toSurface='chore': task gained a due date.
 *   - Delete the list_item, then create a chore.
 * fromSurface='chore', toSurface='list': task lost its due date.
 *   - Delete the chore, then create a list_item.
 *
 * Atomic: delete old-surface artifact first, then create new-surface artifact.
 * Crash-safe: uses write-ahead for the new create.
 */
export async function runMigrateSurfaceProtocol(
  client: SkylightClient,
  db: D1Database,
  row: MappingRow,
  task: { id: string; content: string; due: { date: string } | null; description: string; labels: string[] },
  fromSurface: 'chore' | 'list',
  toSurface: 'chore' | 'list',
  frameId: string,
  profile: string,
  categoryId: string | null,
  bridgeListId: string,
  dryrun: boolean,
  timezone: string
): Promise<void> {
  console.log(
    `[skylight-sync] migrate-surface: task ${task.id} ${fromSurface} → ${toSurface}`
  );

  // Step 1: delete the old-surface artifact
  if (fromSurface === 'list') {
    // Delete the list_item
    await runDeleteListItemProtocol(client, db, row, bridgeListId, dryrun);
  } else {
    // Delete the chore
    await runDeleteProtocol(client, db, row);
  }

  // After deletion, the old row is hard-deleted. Now create the new-surface artifact.
  // Step 2: create the new-surface artifact
  if (toSurface === 'chore') {
    // Task gained a due date — create a chore
    const occDate = task.due?.date ?? '';
    await runCreateProtocol(
      client,
      db,
      task,
      null, // existingRow is gone after delete
      frameId,
      profile,
      occDate,
      categoryId,
      timezone
    );
  } else {
    // Task lost its due date — create a list_item
    await runCreateListItemProtocol(
      client,
      db,
      task,
      null, // existingRow is gone after delete
      frameId,
      profile,
      bridgeListId,
      dryrun
    );
  }

  console.log(
    `[skylight-sync] migrate-surface: completed migration ${fromSurface} → ${toSurface} for task ${task.id}`
  );
}

// ---------------------------------------------------------------------------
// Phase 2c: Inbound list poll — detect device-completed list items
// ---------------------------------------------------------------------------

/**
 * Poll the dedicated bridge list for items completed on the device.
 *
 * For each list_item in the bridge list:
 *   - If status='completed' AND we have an active mapping for this item id:
 *     - Echo guard: if last_pushed_status='complete', skip (we pushed it).
 *     - If the Todoist task is still open → close it (CLOSE_TODOIST).
 *     - Update last_pushed_status='complete' in D1.
 *
 * DRYRUN: no Todoist mutations.
 */
export async function runInboundListPoll(
  client: SkylightClient,
  db: D1Database,
  frameId: string,
  bridgeListId: string,
  deps: InboundPassDeps
): Promise<void> {
  const { getTaskFn, closeTaskFn, todoistApiToken, dryrun } = deps;

  console.log('[skylight-sync] inbound list poll: checking device-completed list items');

  // Skip if bridge list is synthetic (DRYRUN) or invalid
  if (
    !bridgeListId ||
    bridgeListId === DRYRUN_SYNTHETIC_LIST_ID
  ) {
    console.log('[skylight-sync] inbound list poll: bridge list id is synthetic — skipping');
    return;
  }

  // GET all items in the bridge list
  const items = await client.getListItems(bridgeListId);
  if (items.length === 0) return;

  // Load all active list mappings to correlate by skylight_id
  const listMappings = await getActiveMappingsBySurface(db, 'list');
  if (listMappings.length === 0) return;

  // Build a map of skylight_id → row for fast lookup
  const idToRow = new Map<string, MappingRow>();
  for (const row of listMappings) {
    if (row.skylight_id && row.frame_id === frameId) {
      idToRow.set(row.skylight_id, row);
    }
  }

  for (const item of items) {
    if (item.attributes.status !== 'completed') continue;

    const row = idToRow.get(item.id);
    if (!row) continue;

    // Echo guard: if we pushed completed, skip
    if (row.last_pushed_status === 'complete' || row.last_pushed_status === 'completed') {
      continue;
    }

    // Device completed this item — close the Todoist task
    console.log(
      `[skylight-sync] inbound list poll: item ${item.id} completed on device — closing Todoist task ${row.todoist_id}`
    );

    // Fetch current Todoist task to confirm it's still open
    const task = await getTaskFn(row.todoist_id, todoistApiToken);
    if (!task) {
      // Task gone from Todoist — clean up the mapping
      console.log(
        `[skylight-sync] inbound list poll: Todoist task ${row.todoist_id} not found — dropping mapping`
      );
      await hardDeleteRow(db, row.todoist_id, row.occurrence_date, dryrun);
      continue;
    }

    if (task.checked) {
      // Already complete in Todoist — just update our last_pushed_status
      await updatePushedStatus(db, row.todoist_id, row.occurrence_date, 'complete', dryrun);
      continue;
    }

    // Close the Todoist task
    if (dryrun) {
      console.log(`[skylight-sync] DRYRUN: would close Todoist task ${row.todoist_id} (list item completed on device)`);
    } else {
      await closeTaskFn(row.todoist_id, todoistApiToken);
      await updatePushedStatus(db, row.todoist_id, row.occurrence_date, 'complete');
    }
  }
}

// ---------------------------------------------------------------------------
// Inbound pass: Skylight → Todoist
//
// For each active mapping:
//   1. §9 frame_id guard — skip rows not belonging to the running frame
//   2. §9 summary fingerprint detach guard — mark detached if on-device summary diverged
//   3. Always fetch the Todoist task by id (captures completions missed by open-task-list)
//   4. §7B: task-gone sweep — if task deleted from Todoist, run delete protocol
//   5. §7A: Todoist-side completion — if task.checked but chore pending, complete chore
//   6. §8: device-side completion / reopen — drive through decide()
//
// Dependencies are injected for testability. Production callers use the
// default implementations (getTask, closeTask from todoist-client.ts).
// ---------------------------------------------------------------------------

export interface InboundPassDeps {
  /** Fetch a Todoist task by id; return null on 404. */
  getTaskFn: (taskId: string, token: string) => Promise<import('./types.js').RawTask | null>;
  /** Close (complete) a Todoist task. MUST be DRYRUN-gated by the caller. */
  closeTaskFn: (taskId: string, token: string) => Promise<void>;
  /**
   * Fetch a Todoist task AFTER a close (advance) to get the updated due date.
   * For recurring tasks, this is the same as getTaskFn but called post-close.
   * Defaults to getTaskFn if not provided.
   */
  getTaskAfterCloseFn?: (taskId: string, token: string) => Promise<import('./types.js').RawTask | null>;
  /** Todoist API token. */
  todoistApiToken: string;
  /** Whether DRYRUN mode is active — gates Todoist mutations. */
  dryrun: boolean;
  /**
   * Profile → categoryId map (needed for roll creates in the inbound pass).
   * Keys: profile names ('kyle', 'amy'); values: Skylight category ids.
   */
  profileCategoryMap?: Record<string, string>;
  /** Frame timezone (needed for roll creates). */
  timezone?: string;
  /**
   * Bridge list id for the dedicated "▸ FairPlay" list (phase 2c).
   * Required for list-surface rows in the inbound pass.
   */
  bridgeListId?: string;
}

export async function runInboundPass(
  client: SkylightClient,
  db: D1Database,
  frameId: string,
  deps: InboundPassDeps
): Promise<void> {
  const {
    getTaskFn,
    closeTaskFn,
    getTaskAfterCloseFn,
    todoistApiToken,
    dryrun,
    profileCategoryMap = {},
    timezone = 'America/New_York',
    bridgeListId,
  } = deps;
  const fetchAfterClose = getTaskAfterCloseFn ?? getTaskFn;
  console.log('[skylight-sync] inbound pass: checking device completions');

  const activeMappings = await getActiveMappings(db);
  console.log(`[skylight-sync] inbound: ${activeMappings.length} active mappings`);

  for (const row of activeMappings) {
    try {
      // §9 Structural frame guard — refuse any write where row.frame_id != running frameId
      if (row.frame_id !== frameId) {
        console.warn(
          `[skylight-sync] inbound: skipping row ${row.todoist_id}/${row.occurrence_date} — ` +
            `frame_id=${row.frame_id} != running frameId=${frameId} (cross-frame guard)`
        );
        continue;
      }

      if (!row.skylight_id) continue;

      // ── Phase 2c: list-surface rows — task gone check only ─────────────────
      // List item status updates are handled by runInboundListPoll (separate poll).
      // Here we only handle task-gone (Todoist task deleted → delete list item).
      if (row.surface === 'list') {
        const task = await getTaskFn(row.todoist_id, todoistApiToken);
        if (!task) {
          console.log(
            `[skylight-sync] inbound: Todoist task ${row.todoist_id} not found — running delete list item protocol`
          );
          const effectiveBridgeListId = bridgeListId ?? '';
          await runDeleteListItemProtocol(client, db, row, effectiveBridgeListId, dryrun);
        }
        // If task exists but is now completed, the list poll handles it
        continue;
      }

      // §7B: per-id read via list — never infer from list-absence
      const observed = await client.getChoreById(row.skylight_id, row.occurrence_date);

      if (observed === null) {
        // Confirmed 404 — device-side delete (§8: drop mapping, no auto-recreate)
        console.log(
          `[skylight-sync] inbound: chore ${row.skylight_id} is 404 — ` +
            `device deleted it. Dropping mapping (no auto-recreate).`
        );
        await hardDeleteRow(db, row.todoist_id, row.occurrence_date, dryrun);
        continue;
      }

      // §9 Description-marker detach guard — before any write confirm the live chore's
      // attributes.description still carries our ownership marker.
      // The marker is deterministic from the todoist_id: "FPSYNC|<todoist_id>".
      // A missing/wrong marker means the chore was replaced or the description was cleared.
      // Stop syncing it.
      const expectedDescMarker = choreDescriptionMarker(row.todoist_id);
      if (!descriptionMatchesMarker(observed.attributes.description, expectedDescMarker)) {
        console.error(
          `[skylight-sync] inbound: description marker mismatch for chore ${row.skylight_id}. ` +
            `Expected: "${expectedDescMarker}", got: "${observed.attributes.description}". ` +
            `Marking detached — manual review needed.`
        );
        await markDetached(db, row.todoist_id, row.occurrence_date, dryrun);
        continue;
      }

      const observedStatus = observed.attributes.status;

      // Update observed_status in D1
      await updateObservedStatus(db, row.todoist_id, row.occurrence_date, observedStatus, dryrun);

      // Always fetch the current Todoist task by id — this captures Todoist-side completions
      // which are invisible to the open-task-list used in the outbound pass.
      const task = await getTaskFn(row.todoist_id, todoistApiToken);

      if (!task) {
        // §7A: Task gone from Todoist — run delete protocol regardless of echo state
        console.log(
          `[skylight-sync] inbound: Todoist task ${row.todoist_id} not found — running delete protocol`
        );
        const goneActions = decideTaskGone(row);
        for (const action of goneActions) {
          if (action.type === 'DELETE_CHORE') {
            await runDeleteProtocol(client, db, row, dryrun);
          } else if (action.type === 'DELETE_LIST_ITEM') {
            const effectiveBridgeListId = bridgeListId ?? '';
            await runDeleteListItemProtocol(client, db, row, effectiveBridgeListId, dryrun);
          }
        }
        continue;
      }

      // Build a synthetic RawTask-shaped object for decide()
      const rawTask = {
        id: row.todoist_id,
        content: task.content,
        description: task.description ?? '',
        labels: task.labels ?? [],
        project_id: task.project_id ?? '',
        section_id: task.section_id ?? null,
        parent_id: task.parent_id ?? null,
        due: task.due ?? null,
        priority: task.priority ?? 1,
        checked: task.checked,
      } as import('./types.js').RawTask;

      const todoistStatus = task.checked ? 'complete' : 'pending';
      const lastPushed = row.last_pushed_status ?? 'pending';

      // §7A: Todoist-side completion — outbound open-task-list misses completed tasks.
      // If Todoist task is checked but we haven't yet pushed complete to Skylight, do it now.
      if (task.checked && lastPushed !== 'complete' && observedStatus !== 'complete') {
        console.log(
          `[skylight-sync] inbound: Todoist task ${row.todoist_id} is complete but chore ` +
            `${row.skylight_id} is still pending — completing chore`
        );
        await runCompleteProtocol(client, db, row, dryrun);
        continue;
      }

      // §8 Echo guard: only propagate if observed != last_pushed
      if (observedStatus === lastPushed) {
        // This is what we last pushed — echo. No-op.
        continue;
      }

      // §8: propagate only when observed != current Todoist truth
      if (observedStatus === todoistStatus) {
        // Both sides already agree — update last_pushed to reflect reality so
        // a future device reopen is not mistaken for an echo. (Fix for double-completion cross.)
        await updatePushedStatus(db, row.todoist_id, row.occurrence_date, observedStatus as 'pending' | 'complete', dryrun);
        continue;
      }

      // Use decide() as single source of truth for inbound actions
      const actions = decide(rawTask, row, observed, frameId, row.profile);

      for (const action of actions) {
        switch (action.type) {
          case 'CLOSE_TODOIST': {
            // Device completed non-recurring → close Todoist task
            console.log(
              `[skylight-sync] inbound: device completed chore ${row.skylight_id} — closing Todoist task ${row.todoist_id}`
            );
            if (dryrun) {
              console.log(`[skylight-sync] DRYRUN: would close Todoist task ${row.todoist_id}`);
            } else {
              await closeTaskFn(row.todoist_id, todoistApiToken);
              await updatePushedStatus(db, row.todoist_id, row.occurrence_date, 'complete');
            }
            break;
          }
          case 'CLOSE_AND_ROLL_TODOIST': {
            // §5: Device completed a recurring occurrence → close Todoist (advances due) → roll.
            // The close IS the advance; we then re-fetch to learn the new due date.
            console.log(
              `[skylight-sync] inbound: device completed recurring chore ${row.skylight_id} — ` +
                `closing Todoist task ${row.todoist_id} (advance) then rolling`
            );

            if (dryrun) {
              // DRYRUN: log what would happen; do NOT mutate D1 or close Todoist
              console.log(
                `[skylight-sync] DRYRUN: would close Todoist task ${row.todoist_id} (advance) and roll occurrence`
              );
              break;
            }

            // Close (advance) the Todoist task
            await closeTaskFn(row.todoist_id, todoistApiToken);

            // Re-fetch task to learn the new due date (post-advance)
            const advancedTask = await fetchAfterClose(row.todoist_id, todoistApiToken);

            if (!advancedTask || !advancedTask.due) {
              // Task gone or lost its due date — just drop the mapping
              console.warn(
                `[skylight-sync] inbound: recurring task ${row.todoist_id} has no due after close — dropping old row`
              );
              await hardDeleteRow(db, row.todoist_id, row.occurrence_date);
              break;
            }

            const newOccDate = advancedTask.due.date;
            if (!newOccDate || newOccDate <= row.occurrence_date) {
              // No advance detected (stale/ping-pong guard)
              console.warn(
                `[skylight-sync] inbound: recurring task ${row.todoist_id} new due ${newOccDate} ` +
                  `not strictly > stored ${row.occurrence_date} — skipping roll`
              );
              await updatePushedStatus(db, row.todoist_id, row.occurrence_date, 'complete');
              break;
            }

            // Roll: delete old occurrence chore, create new one
            console.log(
              `[skylight-sync] inbound: rolling ${row.todoist_id} from ${row.occurrence_date} → ${newOccDate}`
            );
            const rowCategoryId = profileCategoryMap[row.profile] ?? null;
            await runRollProtocol(
              client, db, row, newOccDate,
              {
                id: row.todoist_id,
                content: advancedTask.content,
                due: advancedTask.due,
                description: advancedTask.description ?? '',
                labels: advancedTask.labels ?? [],
              },
              frameId, row.profile, rowCategoryId, timezone
            );
            break;
          }
          case 'REOPEN_TODOIST': {
            // Device reopened but Todoist is closed → re-assert Todoist truth (push complete back to device)
            console.log(
              `[skylight-sync] inbound: device reopened chore ${row.skylight_id} but Todoist is closed — re-asserting complete`
            );
            if (dryrun) {
              console.log(`[skylight-sync] DRYRUN: would re-assert complete on ${row.skylight_id}`);
            } else {
              await client.completeChore(row.skylight_id);
              await client.verifyCompleted(row.skylight_id, row.occurrence_date);
              await updatePushedStatus(db, row.todoist_id, row.occurrence_date, 'complete');
            }
            break;
          }
          case 'NOOP':
            break;
          default:
            break;
        }
      }
    } catch (err) {
      if (err instanceof TodoistRateLimitError) {
        console.error('[skylight-sync] 429 exhausted in inbound pass — checkpointing');
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[skylight-sync] inbound error for mapping ${row.todoist_id}/${row.skylight_id}: ${msg}`
      );
      // Continue — idempotent resume
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduled handler
// ---------------------------------------------------------------------------

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const runId = crypto.randomUUID();
    const dryrun = (env.DRYRUN ?? 'true') !== 'false';
    const frameId = env.FRAME ?? '5381689'; // default to test frame
    const expectedFingerprint =
      env.FRAME_CONFIRMED ?? (frameId === '5356033' ? '' : '5381689:thehd');
    const timezone = env.FRAME_TIMEZONE ?? 'America/New_York';

    console.log(
      `[skylight-sync] run ${runId} starting. dryrun=${dryrun} frame=${frameId} ` +
        `fingerprint="${expectedFingerprint}"`
    );

    // ── Lease ──────────────────────────────────────────────────────────────
    const leaseAcquired = await acquireLease(env.DB, runId);
    if (!leaseAcquired) {
      console.log('[skylight-sync] another run is active — exiting (lease held)');
      return;
    }

    try {
      // ── Skylight token ────────────────────────────────────────────────────
      const token = await getSkylightToken(env);

      // ── Frame fingerprint assert (§9) ─────────────────────────────────────
      const client = new SkylightClient({ frameId, dryrun, token });

      if (expectedFingerprint) {
        try {
          await client.assertFrameFingerprint(expectedFingerprint);
          console.log(`[skylight-sync] frame fingerprint OK: ${expectedFingerprint}`);
        } catch (err) {
          if (err instanceof FrameGuardError) {
            console.error(`[skylight-sync] HARD ABORT: ${err.message}`);
            return;
          }
          throw err;
        }
      } else if (frameId === '5356033') {
        // Real frame but no FRAME_CONFIRMED — hard abort (§9)
        console.error(
          '[skylight-sync] HARD ABORT: FRAME_CONFIRMED not set for real frame 5356033. ' +
            'Set FRAME_CONFIRMED=5356033:heutoncal to enable real-frame writes.'
        );
        return;
      }

      // ── 401 retry wrapper ─────────────────────────────────────────────────
      const withReauth = async <T>(fn: () => Promise<T>): Promise<T> => {
        try {
          return await fn();
        } catch (err) {
          if (err instanceof SkylightApiError && err.status === 401) {
            console.log('[skylight-sync] 401 — re-authenticating and retrying');
            const newToken = await pkceAuth(env.SKYLIGHT_EMAIL, env.SKYLIGHT_PASSWORD);
            client.updateToken(newToken);
            await env.KV.put(KV_SKYLIGHT_TOKEN, newToken, { expirationTtl: 3300 });
            const now = Math.floor(Date.now() / 1000);
            await env.KV.put(KV_SKYLIGHT_TOKEN_EXP, String(now + 3300));
            return await fn();
          }
          throw err;
        }
      };

      const profileCategoryMap = parseProfileCategoryMap(env.PROFILE_CATEGORY_MAP ?? '{}');

      // Warn at startup if any synced profile is missing a category mapping.
      // An empty or partial map means those profiles will create unassigned (up_for_grabs) chores.
      for (const profile of PROFILES) {
        if (!profileCategoryMap[profile]) {
          console.warn(
            `[skylight-sync] PROFILE_CATEGORY_MAP has no entry for profile "${profile}" — ` +
              `chores created for this profile will be unassigned (up_for_grabs). ` +
              `Set PROFILE_CATEGORY_MAP={"${profile}":"<category_id>",...} to assign them.`
          );
        }
      }

      // ── Orphan sweep: clean up stale 'deleting' rows before outbound pass ───
      // Handles interrupted rolls where the prior run died after DELETE+verify but
      // before hardDeleteRow. The row is stuck in 'deleting' and invisible to the
      // normal active-row scans. This sweep resumes or hard-deletes them (major fix).
      await runOrphanSweep(client, env.DB, frameId, dryrun);

      // ── Phase 2c: ensure the dedicated bridge list exists ─────────────────
      let bridgeListId: string | undefined;
      try {
        bridgeListId = await ensureFairPlayList(client, env.KV, dryrun);
        console.log(`[skylight-sync] bridge list id: ${bridgeListId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[skylight-sync] ensureFairPlayList failed — skipping list sync: ${msg}`);
        // Continue without list support — chore sync still works
      }

      // ── Outbound pass (per profile) ───────────────────────────────────────
      for (const profile of PROFILES) {
        const categoryId = profileCategoryMap[profile] ?? null;
        await withReauth(() =>
          runOutboundPass(client, env.DB, env, frameId, profile, categoryId, timezone, bridgeListId)
        );
      }

      // ── Inbound pass ──────────────────────────────────────────────────────
      await withReauth(() =>
        runInboundPass(client, env.DB, frameId, {
          getTaskFn: getTask,
          closeTaskFn: closeTask,
          todoistApiToken: env.TODOIST_API_TOKEN,
          dryrun,
          profileCategoryMap,
          timezone,
          bridgeListId,
        })
      );

      // ── Phase 2c: inbound list poll (device-completed list items → Todoist) ──
      if (bridgeListId) {
        await withReauth(() =>
          runInboundListPoll(client, env.DB, frameId, bridgeListId!, {
            getTaskFn: getTask,
            closeTaskFn: closeTask,
            todoistApiToken: env.TODOIST_API_TOKEN,
            dryrun,
          })
        );
      }

      // ── Ops: log needs_review / detached counts ───────────────────────────
      const reviewRows = await getReviewRows(env.DB);
      if (reviewRows.length > 0) {
        console.warn(
          `[skylight-sync] ${reviewRows.length} row(s) need manual review: ` +
            reviewRows.map((r) => `${r.todoist_id}/${r.occurrence_date}(${r.state})`).join(', ')
        );
      }

      console.log(`[skylight-sync] run ${runId} completed successfully`);
    } catch (err) {
      if (err instanceof TodoistRateLimitError) {
        console.error('[skylight-sync] rate-limit checkpoint — run will resume on next cron tick');
      } else if (err instanceof FrameGuardError) {
        console.error(`[skylight-sync] frame guard error — aborting: ${err.message}`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[skylight-sync] run ${runId} failed: ${msg}`);
      }
    } finally {
      await releaseLease(env.DB, runId);
      console.log(`[skylight-sync] lease released for run ${runId}`);
    }
  },
};
