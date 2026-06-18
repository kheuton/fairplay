/**
 * Tests for reconcile.ts — pure decision logic.
 *
 * Covers the decide() truth table:
 *   1. Not mapped (no row) → CREATE_CHORE
 *   2. Todoist completed, row active → COMPLETE_CHORE
 *   3. Device completed (observed complete, last_pushed pending) → CLOSE_TODOIST
 *   4. Echo guard (observed complete, last_pushed complete) → NOOP
 *   5. Device reopen (observed pending, last_pushed complete, Todoist checked) → REOPEN_TODOIST
 *   6. Recurring task → SKIP_RECURRING
 *   7. No due date task → SKIP_NO_DUE
 *   8. Detached row → SKIP_DETACHED
 *   9. Frame mismatch → SKIP_FRAME_MISMATCH
 *   10. surface() and fingerprint() correctness
 */

import { describe, it, expect } from 'vitest';
import { decide, surface, fingerprint, decideTaskGone } from './reconcile.js';
import type { RawTask, MappingRow, ChoreResource } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<RawTask> = {}): RawTask {
  return {
    id: 'task-abc123',
    content: 'Take out trash',
    description: '',
    labels: [],
    project_id: 'proj-1',
    section_id: null,
    parent_id: null,
    due: {
      date: '2026-06-20',
      string: 'Jun 20',
      is_recurring: false,
    },
    priority: 1,
    checked: false,
    ...overrides,
  };
}

function makeRow(overrides: Partial<MappingRow> = {}): MappingRow {
  return {
    todoist_id: 'task-abc123',
    fp_stable_id: null,
    occurrence_date: '2026-06-20',
    surface: 'chore',
    frame_id: 'frame-test',
    profile: 'kyle',
    skylight_id: 'sky-001',
    expected_summary: 'Take out trash ▸abc123',
    last_pushed_status: 'pending',
    observed_status: 'pending',
    last_pushed_hash: 'Take out trash|2026-06-20|kyle',
    state: 'active',
    idem_token: 'abc123',
    updated_at: null,
    ...overrides,
  };
}

function makeChore(overrides: Partial<ChoreResource['attributes']> = {}): ChoreResource {
  return {
    id: 'sky-001',
    type: 'chore',
    attributes: {
      summary: 'Take out trash ▸abc123',
      status: 'pending',
      start: '2026-06-20',
      start_time: null,
      recurring: false,
      completed_on: null,
      emoji_icon: null,
      reward_points: null,
      category_id: null,
      category_ids: null,
      ...overrides,
    },
  };
}

const FRAME = 'frame-test';
const PROFILE = 'kyle';

// ---------------------------------------------------------------------------
// surface() tests
// ---------------------------------------------------------------------------

describe('surface()', () => {
  it('returns chore for a non-recurring task with a due date', () => {
    const task = makeTask();
    const result = surface(task);
    expect(result.kind).toBe('chore');
    if (result.kind === 'chore') {
      expect(result.occurrenceDate).toBe('2026-06-20');
    }
  });

  it('returns list for a task without a due date (phase 2c: no-due → list surface)', () => {
    const task = makeTask({ due: null });
    const result = surface(task);
    // Phase 2c: no-due tasks are mirrored as list items, not skipped
    expect(result.kind).toBe('list');
  });

  it('returns chore with isRecurring=true for a recurring task (§5 phase 2b)', () => {
    const task = makeTask({
      due: { date: '2026-06-20', string: 'every day', is_recurring: true },
    });
    const result = surface(task);
    // Phase 2b: recurring tasks use the rolling-occurrence model — surface() returns
    // 'chore' with isRecurring=true rather than 'skip_recurring'.
    expect(result.kind).toBe('chore');
    if (result.kind === 'chore') {
      expect(result.isRecurring).toBe(true);
      expect(result.occurrenceDate).toBe('2026-06-20');
    }
  });
});

// ---------------------------------------------------------------------------
// fingerprint() tests
// ---------------------------------------------------------------------------

describe('fingerprint()', () => {
  it('returns a deterministic string for the same task+profile', () => {
    const task = makeTask();
    const fp1 = fingerprint(task, 'kyle');
    const fp2 = fingerprint(task, 'kyle');
    expect(fp1).toBe(fp2);
  });

  it('differs when content changes', () => {
    const task1 = makeTask({ content: 'Take out trash' });
    const task2 = makeTask({ content: 'Do dishes' });
    expect(fingerprint(task1, 'kyle')).not.toBe(fingerprint(task2, 'kyle'));
  });

  it('differs when due date changes', () => {
    const task1 = makeTask({ due: { date: '2026-06-20', string: 'Jun 20', is_recurring: false } });
    const task2 = makeTask({ due: { date: '2026-06-21', string: 'Jun 21', is_recurring: false } });
    expect(fingerprint(task1, 'kyle')).not.toBe(fingerprint(task2, 'kyle'));
  });

  it('differs when profile changes', () => {
    const task = makeTask();
    expect(fingerprint(task, 'kyle')).not.toBe(fingerprint(task, 'amy'));
  });

  it('includes content, due date, and profile', () => {
    const task = makeTask({ content: 'Hello', due: { date: '2026-01-01', string: 'Jan 1', is_recurring: false } });
    const fp = fingerprint(task, 'kyle');
    expect(fp).toContain('Hello');
    expect(fp).toContain('2026-01-01');
    expect(fp).toContain('kyle');
  });
});

// ---------------------------------------------------------------------------
// decide() truth table
// ---------------------------------------------------------------------------

describe('decide()', () => {
  // ── 1. Not mapped → CREATE ─────────────────────────────────────────────────
  it('returns CREATE_CHORE when task has no mapping row', () => {
    const task = makeTask();
    const actions = decide(task, null, null, FRAME, PROFILE);
    expect(actions).toContainEqual({ type: 'CREATE_CHORE' });
  });

  it('returns CREATE_CHORE when row is in creating state with no skylight_id', () => {
    const task = makeTask();
    const row = makeRow({ state: 'creating', skylight_id: null });
    const actions = decide(task, row, null, FRAME, PROFILE);
    expect(actions).toContainEqual({ type: 'CREATE_CHORE' });
  });

  // ── 2. Todoist completed → COMPLETE_CHORE ─────────────────────────────────
  it('returns COMPLETE_CHORE when Todoist task is checked and row has pending status', () => {
    const task = makeTask({ checked: true });
    const row = makeRow({ last_pushed_status: 'pending' });
    const actions = decide(task, row, null, FRAME, PROFILE);
    expect(actions).toContainEqual({ type: 'COMPLETE_CHORE' });
  });

  it('returns NOOP when Todoist task is checked and last_pushed_status is already complete', () => {
    const task = makeTask({ checked: true });
    const row = makeRow({ last_pushed_status: 'complete' });
    const actions = decide(task, row, null, FRAME, PROFILE);
    expect(actions).toContainEqual({ type: 'NOOP' });
    expect(actions).not.toContainEqual({ type: 'COMPLETE_CHORE' });
  });

  it('returns NOOP when Todoist task is checked but has no mapping', () => {
    const task = makeTask({ checked: true });
    const actions = decide(task, null, null, FRAME, PROFILE);
    expect(actions).toContainEqual({ type: 'NOOP' });
    expect(actions).not.toContainEqual({ type: 'COMPLETE_CHORE' });
  });

  // ── 3. Device completed (observed complete, last_pushed pending) → CLOSE_TODOIST
  it('returns CLOSE_TODOIST when observed=complete, last_pushed=pending, Todoist open', () => {
    const task = makeTask({ checked: false });
    const row = makeRow({ last_pushed_status: 'pending', last_pushed_hash: fingerprint(task, PROFILE) });
    const chore = makeChore({ status: 'complete' });
    const actions = decide(task, row, chore, FRAME, PROFILE);
    expect(actions).toContainEqual({ type: 'CLOSE_TODOIST' });
  });

  // ── 4. Echo guard (observed complete, last_pushed complete) → NOOP ─────────
  it('returns NOOP (echo guard) when observed=complete and last_pushed=complete', () => {
    const task = makeTask({ checked: false });
    const row = makeRow({
      last_pushed_status: 'complete',
      last_pushed_hash: fingerprint(task, PROFILE),
    });
    const chore = makeChore({ status: 'complete' });
    const actions = decide(task, row, chore, FRAME, PROFILE);
    // Should NOT return CLOSE_TODOIST — this is an echo
    expect(actions).not.toContainEqual({ type: 'CLOSE_TODOIST' });
    expect(actions).toContainEqual({ type: 'NOOP' });
  });

  // ── 5. Device reopen → REOPEN_TODOIST ────────────────────────────────────
  it('returns REOPEN_TODOIST when observed=pending, last_pushed=complete, Todoist checked', () => {
    const task = makeTask({ checked: true });
    const row = makeRow({
      last_pushed_status: 'complete',
      last_pushed_hash: fingerprint(makeTask({ checked: false }), PROFILE),
    });
    const chore = makeChore({ status: 'pending' });
    const actions = decide(task, row, chore, FRAME, PROFILE);
    expect(actions).toContainEqual({ type: 'REOPEN_TODOIST' });
  });

  // ── 6. Recurring task (§5 phase 2b) → CREATE_CHORE for new occurrence ────────
  it('returns CREATE_CHORE for a recurring task with no existing row (§5 phase 2b)', () => {
    // Phase 2b: recurring tasks are handled via rolling-occurrence model.
    // A new recurring task with no mapping → CREATE_CHORE for the current occurrence.
    const task = makeTask({
      due: { date: '2026-06-20', string: 'every day', is_recurring: true },
    });
    const actions = decide(task, null, null, FRAME, PROFILE);
    expect(actions).toContainEqual({ type: 'CREATE_CHORE' });
  });

  it('returns ROLL_CHORE when recurring task due advances beyond stored occurrence_date (§5)', () => {
    // Task was at 2026-06-20, now it's at 2026-06-21 (due advanced)
    const task = makeTask({
      due: { date: '2026-06-21', string: 'every day', is_recurring: true },
    });
    // Existing row is for 2026-06-20 (old occurrence)
    const row = makeRow({
      occurrence_date: '2026-06-20',
      state: 'active',
      skylight_id: 'sky-001',
    });
    const actions = decide(task, row, null, FRAME, PROFILE);
    expect(actions).toContainEqual({ type: 'ROLL_CHORE', newOccurrenceDate: '2026-06-21' });
  });

  it('returns NOOP (no roll) when recurring task due equals stored occurrence_date (stale/ping-pong guard)', () => {
    // Same occurrence_date → no roll (prevents double-advance)
    const task = makeTask({
      due: { date: '2026-06-20', string: 'every day', is_recurring: true },
    });
    const row = makeRow({
      occurrence_date: '2026-06-20',
      state: 'active',
      skylight_id: 'sky-001',
      last_pushed_hash: fingerprint(makeTask(), PROFILE),
    });
    const chore = makeChore({ status: 'pending' });
    const actions = decide(task, row, chore, FRAME, PROFILE);
    // Should NOT produce ROLL_CHORE — dates are equal
    expect(actions.some((a) => a.type === 'ROLL_CHORE')).toBe(false);
  });

  it('returns CLOSE_AND_ROLL_TODOIST when device completes a recurring occurrence (§5)', () => {
    // Device completed the chore; Todoist task is still open (recurring, not checked)
    const task = makeTask({
      due: { date: '2026-06-20', string: 'every day', is_recurring: true },
      checked: false,
    });
    const row = makeRow({
      occurrence_date: '2026-06-20',
      state: 'active',
      skylight_id: 'sky-001',
      last_pushed_status: 'pending',
      last_pushed_hash: fingerprint(task, PROFILE),
    });
    const chore = makeChore({ status: 'complete' }); // device completed it
    const actions = decide(task, row, chore, FRAME, PROFILE);
    expect(actions).toContainEqual({ type: 'CLOSE_AND_ROLL_TODOIST' });
  });

  // ── 7. No due date → CREATE_LIST_ITEM (phase 2c) ────────────────────────
  it('returns CREATE_LIST_ITEM for a task with no due date (phase 2c: no-due → list item)', () => {
    const task = makeTask({ due: null });
    const actions = decide(task, null, null, FRAME, PROFILE);
    // Phase 2c: no-due tasks create list items, not chores
    expect(actions.some((a) => a.type === 'CREATE_LIST_ITEM')).toBe(true);
  });

  // ── 8. Detached row → SKIP_DETACHED ───────────────────────────────────────
  it('returns SKIP_DETACHED for a row in detached state', () => {
    const task = makeTask();
    const row = makeRow({ state: 'detached' });
    const actions = decide(task, row, null, FRAME, PROFILE);
    expect(actions.some((a) => a.type === 'SKIP_DETACHED')).toBe(true);
  });

  it('returns SKIP_DETACHED for a row in needs_review state', () => {
    const task = makeTask();
    const row = makeRow({ state: 'needs_review' });
    const actions = decide(task, row, null, FRAME, PROFILE);
    expect(actions.some((a) => a.type === 'SKIP_DETACHED')).toBe(true);
  });

  // ── 9. Frame mismatch → SKIP_FRAME_MISMATCH ──────────────────────────────
  it('returns SKIP_FRAME_MISMATCH when row.frame_id != target frameId', () => {
    const task = makeTask();
    const row = makeRow({ frame_id: 'frame-DIFFERENT' });
    const actions = decide(task, row, null, FRAME, PROFILE);
    expect(actions.some((a) => a.type === 'SKIP_FRAME_MISMATCH')).toBe(true);
  });

  it('returns SKIP_FRAME_MISMATCH when row.profile != current profile', () => {
    const task = makeTask();
    const row = makeRow({ profile: 'amy' }); // but PROFILE='kyle'
    const actions = decide(task, row, null, FRAME, PROFILE);
    expect(actions.some((a) => a.type === 'SKIP_FRAME_MISMATCH')).toBe(true);
  });

  // ── 10. Device 404 → DELETE_CHORE (inbound: observedFetched=true) ──────────
  it('returns DELETE_CHORE when observed chore is null (confirmed 404) and row is active', () => {
    const task = makeTask();
    const row = makeRow({ state: 'active' });
    // observedChore=null with observedFetched=true (default) → confirmed 404 from inbound GET
    const actions = decide(task, row, null, FRAME, PROFILE, true);
    // When the chore is confirmed-404 (inbound per-id GET returned 404), decide returns DELETE_CHORE
    expect(actions).toContainEqual({ type: 'DELETE_CHORE' });
  });

  it('returns NOOP (not DELETE_CHORE) when observedChore is null but observedFetched=false (outbound pass)', () => {
    // The outbound pass never does per-id GETs. null here means "not fetched", NOT "confirmed 404".
    // decide() must return NOOP, not DELETE_CHORE, or it will destroy every healthy active chore.
    const task = makeTask();
    const row = makeRow({
      state: 'active',
      last_pushed_status: 'pending',
      last_pushed_hash: fingerprint(task, PROFILE),
    });
    const actions = decide(task, row, null, FRAME, PROFILE, false);
    // Must NOT return DELETE_CHORE — null here is "not fetched" (outbound pass)
    expect(actions.some((a) => a.type === 'DELETE_CHORE')).toBe(false);
    // Must return NOOP (in-sync, no fetched chore to compare)
    expect(actions).toContainEqual({ type: 'NOOP' });
  });

  // ── 11. NOOP when task and row are in sync ────────────────────────────────
  it('returns NOOP when task and chore are fully in sync', () => {
    const task = makeTask();
    const row = makeRow({
      last_pushed_status: 'pending',
      last_pushed_hash: fingerprint(task, PROFILE),
    });
    const chore = makeChore({ status: 'pending' });
    const actions = decide(task, row, chore, FRAME, PROFILE);
    expect(actions).toContainEqual({ type: 'NOOP' });
    expect(actions.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// decideTaskGone()
// ---------------------------------------------------------------------------

describe('decideTaskGone()', () => {
  it('returns DELETE_CHORE for an active row', () => {
    const row = makeRow({ state: 'active' });
    expect(decideTaskGone(row)).toContainEqual({ type: 'DELETE_CHORE' });
  });

  it('returns DELETE_CHORE for a deleting row', () => {
    const row = makeRow({ state: 'deleting' });
    expect(decideTaskGone(row)).toContainEqual({ type: 'DELETE_CHORE' });
  });

  it('returns NOOP for a creating row', () => {
    const row = makeRow({ state: 'creating' });
    expect(decideTaskGone(row)).toContainEqual({ type: 'NOOP' });
  });
});
