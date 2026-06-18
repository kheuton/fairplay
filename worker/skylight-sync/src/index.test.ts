/**
 * Integration tests for index.ts orchestration layer.
 *
 * These tests import and exercise the REAL exported functions from index.ts:
 *   runCreateProtocol, runInboundPass, runCompleteProtocol, runDeleteProtocol
 *
 * They verify:
 *   (a) A successful create commits exactly one 'active' row with the real summary
 *   (b) An interrupted create (creating row + null skylight_id) resumes without
 *       duplicating (sentinel-based readback, §9)
 *   (c) DRYRUN issues zero mutating fetches to EITHER Skylight or Todoist APIs
 *   (d) A divergent on-device summary marks detached and writes nothing
 *   (e) A row whose frame_id != frameId is skipped inbound
 *   (f) Todoist-side completion propagates to Skylight even when missed by open-task-list
 *   (g) Double-completion cross updates last_pushed_status so a later reopen is not swallowed
 *   (h) DRYRUN: zero mutating fetches to api.todoist.com when a device completes a chore
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MappingRow } from './types.js';
import {
  buildSummary,
  sentinelToken,
  DRYRUN_SYNTHETIC_ID,
  SkylightClient,
  SKYLIGHT_BASE,
  DRYRUN_SYNTHETIC_LIST_ID,
  FAMILY_LIST_IDS,
  BRIDGE_LIST_LABEL,
  assertBridgeListWrite,
  ListWriteGuardError,
  ensureFairPlayList,
} from './skylight-client.js';
import { TODOIST_BASE } from './todoist-client.js';
import { fingerprint } from './reconcile.js';
import {
  runCreateProtocol,
  runInboundPass,
  runCompleteProtocol,
  runDeleteProtocol,
  runRollProtocol,
  runOutboundPass,
  runOrphanSweep,
  runCreateListItemProtocol,
  runCompleteListItemProtocol,
  runDeleteListItemProtocol,
  runMigrateSurfaceProtocol,
  runInboundListPoll,
  buildListItemLabel,
  type InboundPassDeps,
} from './index.js';

// ---------------------------------------------------------------------------
// Minimal in-memory D1 mock
// ---------------------------------------------------------------------------

interface D1Row extends Record<string, unknown> {}

class InMemoryD1 {
  rows = new Map<string, D1Row>();

  private key(r: { todoist_id: string; occurrence_date: string }): string {
    return `${r.todoist_id}:${r.occurrence_date}`;
  }

  getRow(todoistId: string, occurrenceDate: string): D1Row | undefined {
    return this.rows.get(`${todoistId}:${occurrenceDate}`);
  }

  allRows(): D1Row[] {
    return [...this.rows.values()];
  }

  /** Build a D1Database-shaped adapter so we can pass it to the real db.ts functions */
  asD1(): D1Database {
    const self = this;

    function makeStatement(sql: string, bindings: unknown[]) {
      return {
        bind: (...args: unknown[]) => makeStatement(sql, args),
        run: async () => {
          if (sql.includes('INSERT INTO mapping')) {
            const [
              todoist_id, fp_stable_id, occurrence_date, surface, frame_id, profile,
              skylight_id, expected_summary, last_pushed_status, observed_status,
              last_pushed_hash, state, idem_token, updated_at,
            ] = bindings;
            const k = `${todoist_id as string}:${occurrence_date as string}`;
            if (!self.rows.has(k)) {
              self.rows.set(k, {
                todoist_id, fp_stable_id, occurrence_date, surface, frame_id, profile,
                skylight_id, expected_summary, last_pushed_status, observed_status,
                last_pushed_hash, state, idem_token, updated_at,
              });
            }
          } else if (sql.includes("SET state = 'active'")) {
            // commitActiveRow: bind order = skylightId, expectedSummary, lastPushedHash, now, todoistId, occurrenceDate
            const [skylightId, expectedSummary, lastPushedHash, now, todoistId, occurrenceDate] = bindings;
            const k = `${todoistId as string}:${occurrenceDate as string}`;
            const existing = self.rows.get(k) ?? {};
            self.rows.set(k, {
              ...existing,
              state: 'active',
              skylight_id: skylightId,
              expected_summary: expectedSummary,
              last_pushed_status: 'pending',
              last_pushed_hash: lastPushedHash,
              updated_at: now,
            });
          } else if (sql.includes("SET state = 'needs_review'")) {
            const [now, todoistId, occurrenceDate] = bindings;
            const k = `${todoistId as string}:${occurrenceDate as string}`;
            const existing = self.rows.get(k) ?? {};
            self.rows.set(k, { ...existing, state: 'needs_review', updated_at: now });
          } else if (sql.includes("SET state = 'detached'")) {
            const [now, todoistId, occurrenceDate] = bindings;
            const k = `${todoistId as string}:${occurrenceDate as string}`;
            const existing = self.rows.get(k) ?? {};
            self.rows.set(k, { ...existing, state: 'detached', updated_at: now });
          } else if (sql.includes("SET state = 'deleting'")) {
            const [now, todoistId, occurrenceDate] = bindings;
            const k = `${todoistId as string}:${occurrenceDate as string}`;
            const existing = self.rows.get(k) ?? {};
            self.rows.set(k, { ...existing, state: 'deleting', updated_at: now });
          } else if (sql.includes('SET last_pushed_status')) {
            const [status, now, todoistId, occurrenceDate] = bindings;
            const k = `${todoistId as string}:${occurrenceDate as string}`;
            const existing = self.rows.get(k) ?? {};
            self.rows.set(k, { ...existing, last_pushed_status: status, updated_at: now });
          } else if (sql.includes('SET observed_status')) {
            const [status, now, todoistId, occurrenceDate] = bindings;
            const k = `${todoistId as string}:${occurrenceDate as string}`;
            const existing = self.rows.get(k) ?? {};
            self.rows.set(k, { ...existing, observed_status: status, updated_at: now });
          } else if (sql.startsWith('DELETE FROM mapping')) {
            const [todoistId, occurrenceDate] = bindings;
            self.rows.delete(`${todoistId as string}:${occurrenceDate as string}`);
          }
          return { success: true, meta: {}, results: [] };
        },
        first: async <T>() => {
          if (sql.includes('SELECT * FROM mapping WHERE todoist_id = ? AND occurrence_date = ?')) {
            const [todoistId, occurrenceDate] = bindings;
            const k = `${todoistId as string}:${occurrenceDate as string}`;
            return (self.rows.get(k) ?? null) as T;
          }
          return null as T;
        },
        all: async <T>() => {
          // getActiveMappingsBySurface: WHERE state = 'active' AND surface = ?
          if (sql.includes("WHERE state = 'active' AND surface = ?")) {
            const [surface] = bindings;
            const results = [...self.rows.values()].filter(
              (r) => r.state === 'active' && r.surface === surface
            ) as T[];
            return { results, success: true, meta: {} };
          }
          if (sql.includes("WHERE state = 'active'")) {
            const results = [...self.rows.values()].filter((r) => r.state === 'active') as T[];
            return { results, success: true, meta: {} };
          }
          // getMappingsByTodoistId: SELECT * FROM mapping WHERE todoist_id = ?
          if (sql.includes('SELECT * FROM mapping WHERE todoist_id = ?') && !sql.includes('occurrence_date')) {
            const [todoistId] = bindings;
            const results = [...self.rows.values()].filter(
              (r) => r.todoist_id === todoistId
            ) as T[];
            return { results, success: true, meta: {} };
          }
          return { results: [] as T[], success: true, meta: {} };
        },
      };
    }

    return {
      prepare: (sql: string) => makeStatement(sql, []),
    } as unknown as D1Database;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChoreResponse(id: string, summary: string, status = 'pending') {
  return {
    data: {
      id,
      type: 'chore' as const,
      attributes: {
        summary,
        status,
        start: '2026-06-20',
        start_time: null,
        recurring: false,
        completed_on: status === 'complete' ? '2026-06-20' : null,
        emoji_icon: null,
        reward_points: null,
        category_id: null,
        category_ids: null,
      },
    },
  };
}

function makeCreateResponse(id: string, summary: string) {
  return {
    data: [
      {
        id,
        type: 'chore' as const,
        attributes: {
          summary,
          status: 'pending',
          start: '2026-06-20',
          start_time: null,
          recurring: false,
          completed_on: null,
          emoji_icon: null,
          reward_points: null,
          category_id: null,
          category_ids: null,
        },
      },
    ],
  };
}

function makeListResponse(items: Array<{ id: string; summary: string; status?: string }>) {
  return {
    data: items.map((i) => ({
      id: i.id,
      type: 'chore' as const,
      attributes: {
        summary: i.summary,
        status: i.status ?? 'pending',
        start: '2026-06-20',
        start_time: null,
        recurring: false,
        completed_on: null,
        emoji_icon: null,
        reward_points: null,
        category_id: null,
        category_ids: null,
      },
    })),
  };
}

function makeTodoistTask(id: string, checked = false) {
  return {
    id,
    content: TASK_CONTENT,
    description: '',
    labels: [],
    project_id: 'proj-1',
    section_id: null,
    parent_id: null,
    due: { date: OCCURRENCE_DATE, string: 'Jun 20', is_recurring: false },
    priority: 1,
    checked,
  };
}

const TASK_ID = 'task-abc123456';
const TASK_CONTENT = 'Take out trash';
const OCCURRENCE_DATE = '2026-06-20';
const FRAME_ID = 'frame-test';
const PROFILE = 'kyle';

function makeRawTask(overrides: Partial<{
  id: string; content: string; checked: boolean; due: { date: string; string: string; is_recurring: boolean } | null
}> = {}) {
  return {
    id: TASK_ID,
    content: TASK_CONTENT,
    description: '',
    labels: [],
    project_id: 'proj-1',
    section_id: null,
    parent_id: null,
    due: { date: OCCURRENCE_DATE, string: 'Jun 20', is_recurring: false },
    priority: 1,
    checked: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: runCreateProtocol (the REAL function from index.ts)
// ---------------------------------------------------------------------------

describe('runCreateProtocol — integration', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('(a) successful create commits exactly one active row with the correct summary', async () => {
    const db = new InMemoryD1();
    const task = makeRawTask();
    const expectedSummary = buildSummary(task.content, task.id);
    const idemToken = sentinelToken(task.id);

    // POST → create response; GET (read-back) → chore with correct summary
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeCreateResponse('sky-001', expectedSummary),
        text: async () => JSON.stringify(makeCreateResponse('sky-001', expectedSummary)),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeChoreResponse('sky-001', expectedSummary),
        text: async () => JSON.stringify(makeChoreResponse('sky-001', expectedSummary)),
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runCreateProtocol(client, db.asD1(), task, null, FRAME_ID, PROFILE, OCCURRENCE_DATE, null, 'America/New_York');

    const row = db.getRow(task.id, OCCURRENCE_DATE);
    expect(row).toBeDefined();
    expect(row?.state).toBe('active');
    expect(row?.skylight_id).toBe('sky-001');
    expect(row?.expected_summary).toBe(expectedSummary);
    expect(row?.last_pushed_status).toBe('pending');

    // Only one POST
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(postCalls).toHaveLength(1);

    // Verify the idemToken embedded in summary IS the sentinelToken
    expect(expectedSummary).toContain(idemToken);
  });

  it('(a) idemToken passed to createChore equals sentinelToken(task.id)', async () => {
    // Verify the sentinel/idemToken alignment: createChore's .includes(idemToken) check
    // passes because buildSummary embeds exactly sentinelToken(task.id)
    const task = makeRawTask();
    const idemToken = sentinelToken(task.id);
    const summary = buildSummary(task.content, task.id);
    expect(summary).toContain(idemToken);

    // If Skylight returns the same summary, createChore.includes(idemToken) passes
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => makeCreateResponse('sky-002', summary),
      text: async () => JSON.stringify(makeCreateResponse('sky-002', summary)),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const created = await client.createChore({ summary, start: OCCURRENCE_DATE, categoryId: null, idemToken });
    expect(created.id).toBe('sky-002');
  });

  it('(b) interrupted create (creating row, null skylight_id) resumes without re-POSTing', async () => {
    const db = new InMemoryD1();
    const task = makeRawTask();
    const expectedSummary = buildSummary(task.content, task.id);

    // Simulate an existing 'creating' row with no skylight_id (interrupted create)
    const existingRow: MappingRow = {
      todoist_id: task.id,
      fp_stable_id: null,
      occurrence_date: OCCURRENCE_DATE,
      surface: 'chore',
      frame_id: FRAME_ID,
      profile: PROFILE,
      skylight_id: null,
      expected_summary: expectedSummary,
      last_pushed_status: null,
      observed_status: null,
      last_pushed_hash: null,
      state: 'creating',
      idem_token: sentinelToken(task.id),
      updated_at: null,
    };

    // Pre-seed the row in the D1 mock
    db.rows.set(`${task.id}:${OCCURRENCE_DATE}`, existingRow as unknown as D1Row);

    // The chore already exists on Skylight from the interrupted run — returned by listChores
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => makeListResponse([{ id: 'sky-rescued', summary: expectedSummary }]),
      text: async () => JSON.stringify(makeListResponse([{ id: 'sky-rescued', summary: expectedSummary }])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runCreateProtocol(client, db.asD1(), task, existingRow, FRAME_ID, PROFILE, OCCURRENCE_DATE, null, 'America/New_York');

    // Should have committed the found chore, no POST issued
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(postCalls).toHaveLength(0);

    const row = db.getRow(task.id, OCCURRENCE_DATE);
    expect(row?.state).toBe('active');
    expect(row?.skylight_id).toBe('sky-rescued');
  });

  it('(c) DRYRUN issues zero mutating fetches', async () => {
    const db = new InMemoryD1();
    const task = makeRawTask();

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: true, token: 'tok' });

    await runCreateProtocol(client, db.asD1(), task, null, FRAME_ID, PROFILE, OCCURRENCE_DATE, null, 'America/New_York');

    const mutatingCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST' || opts?.method === 'PUT' || opts?.method === 'DELETE'
    );
    expect(mutatingCalls).toHaveLength(0);

    // Row should exist in 'active' state with DRYRUN_SYNTHETIC_ID
    const row = db.getRow(task.id, OCCURRENCE_DATE);
    expect(row?.state).toBe('active');
    expect(row?.skylight_id).toBe(DRYRUN_SYNTHETIC_ID);
  });
});

// ---------------------------------------------------------------------------
// Tests: runInboundPass (the REAL function from index.ts)
// ---------------------------------------------------------------------------

describe('runInboundPass — integration', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function seedActiveRow(
    db: InMemoryD1,
    overrides: Partial<MappingRow> = {}
  ): MappingRow {
    const expected_summary = buildSummary(TASK_CONTENT, TASK_ID);
    const row: MappingRow = {
      todoist_id: TASK_ID,
      fp_stable_id: null,
      occurrence_date: OCCURRENCE_DATE,
      surface: 'chore',
      frame_id: FRAME_ID,
      profile: PROFILE,
      skylight_id: 'sky-001',
      expected_summary,
      last_pushed_status: 'pending',
      observed_status: 'pending',
      last_pushed_hash: fingerprint(makeRawTask() as import('./types.js').RawTask, PROFILE),
      state: 'active',
      idem_token: sentinelToken(TASK_ID),
      updated_at: null,
      ...overrides,
    };
    db.rows.set(`${row.todoist_id}:${row.occurrence_date}`, row as unknown as D1Row);
    return row;
  }

  /** Build a standard InboundPassDeps with mocked get/close Todoist fns */
  function makeDeps(overrides: Partial<InboundPassDeps> = {}): InboundPassDeps & {
    closedTaskIds: string[];
    getTaskCalled: string[];
  } {
    const closedTaskIds: string[] = [];
    const getTaskCalled: string[] = [];
    return {
      getTaskFn: async (id: string) => {
        getTaskCalled.push(id);
        return makeTodoistTask(id) as import('./types.js').RawTask;
      },
      closeTaskFn: async (id: string) => {
        closedTaskIds.push(id);
      },
      todoistApiToken: 'tok-todoist',
      dryrun: false,
      closedTaskIds,
      getTaskCalled,
      ...overrides,
    };
  }

  it('(d) diverged on-device summary marks row detached, no write occurs', async () => {
    const db = new InMemoryD1();
    const task = makeRawTask();
    const row = seedActiveRow(db);

    // Skylight returns a chore with a DIFFERENT summary (sentinel stripped by family member)
    const divergedSummary = 'Take out trash'; // sentinel stripped
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeChoreResponse('sky-001', divergedSummary),
      text: async () => JSON.stringify(makeChoreResponse('sky-001', divergedSummary)),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const deps = makeDeps();

    await runInboundPass(client, db.asD1(), FRAME_ID, deps);

    // Row should be detached
    const finalRow = db.getRow(task.id, OCCURRENCE_DATE);
    expect(finalRow?.state).toBe('detached');

    // No closeTask call to Todoist
    expect(deps.closedTaskIds).toHaveLength(0);

    // No PUT/POST/DELETE to Skylight
    const mutatingCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'PUT' || opts?.method === 'POST' || opts?.method === 'DELETE'
    );
    expect(mutatingCalls).toHaveLength(0);
  });

  it('(e) row with frame_id != running frameId is skipped (no fetch)', async () => {
    const db = new InMemoryD1();
    // Seed a row that belongs to a DIFFERENT frame
    seedActiveRow(db, { frame_id: 'frame-DIFFERENT' });

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const deps = makeDeps();

    await runInboundPass(client, db.asD1(), FRAME_ID, deps);

    // No Skylight GET should have been issued for this row
    expect(fetchSpy.mock.calls).toHaveLength(0);
  });

  it('(f) Todoist-side completion pushes complete to Skylight even when chore is still pending', async () => {
    const db = new InMemoryD1();
    const row = seedActiveRow(db, { last_pushed_status: 'pending' });
    const expectedSummary = row.expected_summary!;

    // GET chore → pending (device hasn't completed it yet)
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeChoreResponse('sky-001', expectedSummary, 'pending'),
        text: async () => JSON.stringify(makeChoreResponse('sky-001', expectedSummary, 'pending')),
        headers: { get: () => null },
      } as unknown as Response)
      // PUT complete (runCompleteProtocol)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{}',
        headers: { get: () => null },
      } as unknown as Response)
      // GET (verifyCompleted)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeChoreResponse('sky-001', expectedSummary, 'complete'),
        text: async () => JSON.stringify(makeChoreResponse('sky-001', expectedSummary, 'complete')),
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    // Todoist task is complete (checked)
    const deps = makeDeps({
      getTaskFn: async (id) => makeTodoistTask(id, true) as import('./types.js').RawTask,
    });

    await runInboundPass(client, db.asD1(), FRAME_ID, deps);

    const putCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'PUT'
    );
    expect(putCalls).toHaveLength(1);

    const finalRow = db.getRow(TASK_ID, OCCURRENCE_DATE);
    expect(finalRow?.last_pushed_status).toBe('complete');
  });

  it('(g) double-completion cross: updates last_pushed_status so a later device reopen is not swallowed', async () => {
    const db = new InMemoryD1();
    seedActiveRow(db, { last_pushed_status: 'pending' });
    const expectedSummary = buildSummary(TASK_CONTENT, TASK_ID);

    // First inbound run: both sides complete → 'already in sync' branch
    // observed=complete, lastPushed=pending → not echo; observed===todoistStatus → update last_pushed
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeChoreResponse('sky-001', expectedSummary, 'complete'),
      text: async () => JSON.stringify(makeChoreResponse('sky-001', expectedSummary, 'complete')),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    // Todoist task is complete
    const depsFirstRun = makeDeps({
      getTaskFn: async (id) => makeTodoistTask(id, true) as import('./types.js').RawTask,
    });
    await runInboundPass(client, db.asD1(), FRAME_ID, depsFirstRun);

    // last_pushed_status should now be 'complete' (not stale 'pending')
    let row = db.getRow(TASK_ID, OCCURRENCE_DATE);
    expect(row?.last_pushed_status).toBe('complete');

    // Now device reopens: observed=pending, Todoist still checked
    // With correct last_pushed='complete', observed='pending' != last_pushed='complete' → not echo
    // → REOPEN_TODOIST path (re-assert complete)
    fetchSpy.mockReset();

    // GET chore → now pending (device reopened it)
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeChoreResponse('sky-001', expectedSummary, 'pending'),
        text: async () => JSON.stringify(makeChoreResponse('sky-001', expectedSummary, 'pending')),
        headers: { get: () => null },
      } as unknown as Response)
      // PUT complete (re-assert)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{}',
        headers: { get: () => null },
      } as unknown as Response)
      // GET (verifyCompleted)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeChoreResponse('sky-001', expectedSummary, 'complete'),
        text: async () => JSON.stringify(makeChoreResponse('sky-001', expectedSummary, 'complete')),
        headers: { get: () => null },
      } as unknown as Response);

    const depsSecondRun = makeDeps({
      getTaskFn: async (id) => makeTodoistTask(id, true) as import('./types.js').RawTask,
    });
    await runInboundPass(client, db.asD1(), FRAME_ID, depsSecondRun);

    // Should have issued a PUT to re-assert complete
    const putCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'PUT'
    );
    expect(putCalls).toHaveLength(1);

    row = db.getRow(TASK_ID, OCCURRENCE_DATE);
    expect(row?.last_pushed_status).toBe('complete');
  });

  it('(c) DRYRUN: no mutating fetches to Skylight during inbound pass (§7A complete path)', async () => {
    const db = new InMemoryD1();
    seedActiveRow(db, { last_pushed_status: 'pending' });
    const expectedSummary = buildSummary(TASK_CONTENT, TASK_ID);

    // GET chore → pending
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeChoreResponse('sky-001', expectedSummary, 'pending'),
      text: async () => JSON.stringify(makeChoreResponse('sky-001', expectedSummary, 'pending')),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: true, token: 'tok' });
    // Todoist task is complete → triggers §7A complete path
    const deps = makeDeps({
      getTaskFn: async (id) => makeTodoistTask(id, true) as import('./types.js').RawTask,
      dryrun: true,
    });

    await runInboundPass(client, db.asD1(), FRAME_ID, deps);

    // No PUT/POST/DELETE to Skylight
    const mutatingCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'PUT' || opts?.method === 'POST' || opts?.method === 'DELETE'
    );
    expect(mutatingCalls).toHaveLength(0);

    // last_pushed_status is still updated in D1 (DRYRUN only suppresses network writes)
    const row = db.getRow(TASK_ID, OCCURRENCE_DATE);
    expect(row?.last_pushed_status).toBe('complete');
  });

  it('(h) DRYRUN: zero mutating fetches to api.todoist.com when device completes a chore', async () => {
    const db = new InMemoryD1();
    // Row where device has completed the chore (observed=complete), Todoist is still pending
    seedActiveRow(db, { last_pushed_status: 'pending', observed_status: 'pending' });
    const expectedSummary = buildSummary(TASK_CONTENT, TASK_ID);

    // GET chore → complete (device completed it)
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeChoreResponse('sky-001', expectedSummary, 'complete'),
      text: async () => JSON.stringify(makeChoreResponse('sky-001', expectedSummary, 'complete')),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: true, token: 'tok' });
    const todositMutatingUrls: string[] = [];
    const deps: InboundPassDeps = {
      getTaskFn: async (id) => makeTodoistTask(id, false) as import('./types.js').RawTask,
      closeTaskFn: async (id) => {
        todositMutatingUrls.push(`${TODOIST_BASE}/api/v1/tasks/${id}/close`);
      },
      todoistApiToken: 'tok-todoist',
      dryrun: true,
    };

    await runInboundPass(client, db.asD1(), FRAME_ID, deps);

    // DRYRUN must suppress closeTaskFn — zero calls to Todoist mutating endpoints
    expect(todositMutatingUrls).toHaveLength(0);

    // D1 state should still be updated (DRYRUN only suppresses HTTP writes)
    const row = db.getRow(TASK_ID, OCCURRENCE_DATE);
    expect(row?.last_pushed_status).toBe('complete');
  });

  it('(f) echo guard: when observed matches last_pushed, no write issued', async () => {
    const db = new InMemoryD1();
    seedActiveRow(db, { last_pushed_status: 'pending' });
    const expectedSummary = buildSummary(TASK_CONTENT, TASK_ID);

    // chore is pending — same as last_pushed → echo
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeChoreResponse('sky-001', expectedSummary, 'pending'),
      text: async () => JSON.stringify(makeChoreResponse('sky-001', expectedSummary, 'pending')),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const deps = makeDeps({
      getTaskFn: async (id) => makeTodoistTask(id, false) as import('./types.js').RawTask,
    });

    await runInboundPass(client, db.asD1(), FRAME_ID, deps);

    expect(deps.closedTaskIds).toHaveLength(0);
    const mutatingCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'PUT' || opts?.method === 'POST' || opts?.method === 'DELETE'
    );
    expect(mutatingCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 2b Tests: Recurrence — Rolling-Occurrence Model (§5)
// All tests call the REAL exported functions from index.ts.
// ---------------------------------------------------------------------------

const RECURRING_TASK_ID = 'task-recur78901';
const RECURRING_OCCURRENCE_DATE = '2026-06-20';
const NEXT_OCCURRENCE_DATE = '2026-06-27'; // one week later

function makeRecurringTodoistTask(id: string, dueDate: string, checked = false) {
  return {
    id,
    content: 'Take out trash',
    description: '',
    labels: [],
    project_id: 'proj-1',
    section_id: null,
    parent_id: null,
    due: { date: dueDate, string: 'every week', is_recurring: true },
    priority: 1,
    checked,
  };
}

describe('Phase 2b: recurring task → creates current occurrence (§5)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('(2b-1) recurring task with no mapping → creates non-recurring chore for current occurrence', async () => {
    const db = new InMemoryD1();
    const task = makeRecurringTodoistTask(RECURRING_TASK_ID, RECURRING_OCCURRENCE_DATE);
    const expectedSummary = buildSummary(task.content, task.id);

    // POST → create response; GET (read-back) → chore
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeCreateResponse('sky-recur-001', expectedSummary),
        text: async () => JSON.stringify(makeCreateResponse('sky-recur-001', expectedSummary)),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeChoreResponse('sky-recur-001', expectedSummary),
        text: async () => JSON.stringify(makeChoreResponse('sky-recur-001', expectedSummary)),
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    // Use runCreateProtocol (what outbound pass would call for a new recurring task)
    await runCreateProtocol(
      client, db.asD1(),
      { id: task.id, content: task.content, due: task.due, description: task.description, labels: task.labels },
      null, FRAME_ID, PROFILE, RECURRING_OCCURRENCE_DATE, null, 'America/New_York'
    );

    const row = db.getRow(RECURRING_TASK_ID, RECURRING_OCCURRENCE_DATE);
    expect(row).toBeDefined();
    expect(row?.state).toBe('active');
    expect(row?.skylight_id).toBe('sky-recur-001');
    expect(row?.occurrence_date).toBe(RECURRING_OCCURRENCE_DATE);

    // Exactly one POST (one chore created, non-recurring)
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(postCalls).toHaveLength(1);
    // Verify the created chore is non-recurring (recurring:false in create body)
    const createBody = JSON.parse((postCalls[0][1]?.body as string) ?? '{}') as Record<string, unknown>;
    expect(createBody['recurring']).toBe(false);
  });

  it('(2b-1-dryrun) DRYRUN: no mutating fetches for recurring task create', async () => {
    const db = new InMemoryD1();
    const task = makeRecurringTodoistTask(RECURRING_TASK_ID, RECURRING_OCCURRENCE_DATE);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: true, token: 'tok' });

    await runCreateProtocol(
      client, db.asD1(),
      { id: task.id, content: task.content, due: task.due, description: task.description, labels: task.labels },
      null, FRAME_ID, PROFILE, RECURRING_OCCURRENCE_DATE, null, 'America/New_York'
    );

    const mutatingCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST' || opts?.method === 'PUT' || opts?.method === 'DELETE'
    );
    expect(mutatingCalls).toHaveLength(0);

    // DRYRUN row is committed with synthetic id
    const row = db.getRow(RECURRING_TASK_ID, RECURRING_OCCURRENCE_DATE);
    expect(row?.state).toBe('active');
    expect(row?.skylight_id).toBe(DRYRUN_SYNTHETIC_ID);
  });
});

describe('Phase 2b: runRollProtocol — outbound due advance (§5)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function makeActiveRecurringRow(db: InMemoryD1, overrides: Partial<MappingRow> = {}): MappingRow {
    const expected_summary = buildSummary('Take out trash', RECURRING_TASK_ID);
    const row: MappingRow = {
      todoist_id: RECURRING_TASK_ID,
      fp_stable_id: null,
      occurrence_date: RECURRING_OCCURRENCE_DATE,
      surface: 'chore',
      frame_id: FRAME_ID,
      profile: PROFILE,
      skylight_id: 'sky-recur-001',
      expected_summary,
      last_pushed_status: 'pending',
      observed_status: 'pending',
      last_pushed_hash: fingerprint(
        makeRecurringTodoistTask(RECURRING_TASK_ID, RECURRING_OCCURRENCE_DATE) as import('./types.js').RawTask,
        PROFILE
      ),
      state: 'active',
      idem_token: sentinelToken(RECURRING_TASK_ID),
      updated_at: null,
      ...overrides,
    };
    db.rows.set(`${row.todoist_id}:${row.occurrence_date}`, row as unknown as D1Row);
    return row;
  }

  it('(2b-3) Todoist due advanced → runRollProtocol deletes old chore, creates new occurrence', async () => {
    const db = new InMemoryD1();
    const oldRow = makeActiveRecurringRow(db);
    const expectedSummary = buildSummary('Take out trash', RECURRING_TASK_ID);
    const task = makeRecurringTodoistTask(RECURRING_TASK_ID, NEXT_OCCURRENCE_DATE);

    // Sequence: GET (delete re-confirm), DELETE, GET (verify-deleted 404),
    // POST (create new), GET (read-back new)
    fetchSpy
      // 1. re-GET old chore (delete protocol step 1)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeChoreResponse('sky-recur-001', expectedSummary),
        text: async () => JSON.stringify(makeChoreResponse('sky-recur-001', expectedSummary)),
        headers: { get: () => null },
      } as unknown as Response)
      // 2. DELETE old chore
      .mockResolvedValueOnce({
        ok: true, status: 204,
        text: async () => '',
        headers: { get: () => null },
      } as unknown as Response)
      // 3. GET verify-deleted → 404
      .mockResolvedValueOnce({
        ok: false, status: 404,
        text: async () => 'Not Found',
        headers: { get: () => null },
      } as unknown as Response)
      // 4. POST create new occurrence
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeCreateResponse('sky-recur-002', expectedSummary),
        text: async () => JSON.stringify(makeCreateResponse('sky-recur-002', expectedSummary)),
        headers: { get: () => null },
      } as unknown as Response)
      // 5. GET read-back new occurrence
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeChoreResponse('sky-recur-002', expectedSummary),
        text: async () => JSON.stringify(makeChoreResponse('sky-recur-002', expectedSummary)),
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runRollProtocol(
      client, db.asD1(), oldRow, NEXT_OCCURRENCE_DATE,
      { id: task.id, content: task.content, due: task.due, description: task.description, labels: task.labels },
      FRAME_ID, PROFILE, null, 'America/New_York'
    );

    // Old row should be gone
    expect(db.getRow(RECURRING_TASK_ID, RECURRING_OCCURRENCE_DATE)).toBeUndefined();

    // New row should exist for the next occurrence
    const newRow = db.getRow(RECURRING_TASK_ID, NEXT_OCCURRENCE_DATE);
    expect(newRow).toBeDefined();
    expect(newRow?.state).toBe('active');
    expect(newRow?.skylight_id).toBe('sky-recur-002');
    expect(newRow?.occurrence_date).toBe(NEXT_OCCURRENCE_DATE);

    // A DELETE was issued for the old chore
    const deleteCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE'
    );
    expect(deleteCalls).toHaveLength(1);

    // A POST was issued for the new chore
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(postCalls).toHaveLength(1);
  });

  it('(2b-4) stale occurrence_date (equal) → no roll (double-advance guard)', async () => {
    // The stale/equal case is handled in decide() — if occurrence_date unchanged, NOOP.
    // Verify via reconcile (pure, no I/O needed) — the actual integration guard is decide().
    // This test confirms runRollProtocol is NOT called when dates are equal.
    // We test this indirectly: seed a row keyed by the SAME date as the task.due.date
    // and confirm no DELETE/POST is issued in an inbound pass.
    const db = new InMemoryD1();
    makeActiveRecurringRow(db); // keyed at RECURRING_OCCURRENCE_DATE
    const expectedSummary = buildSummary('Take out trash', RECURRING_TASK_ID);

    // chore is pending (same as last_pushed — echo)
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => makeChoreResponse('sky-recur-001', expectedSummary, 'pending'),
      text: async () => JSON.stringify(makeChoreResponse('sky-recur-001', expectedSummary, 'pending')),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    // Todoist returns the task with SAME occurrence date as stored (no advance)
    const deps: InboundPassDeps = {
      getTaskFn: async (id) =>
        makeRecurringTodoistTask(id, RECURRING_OCCURRENCE_DATE) as import('./types.js').RawTask,
      closeTaskFn: async () => {},
      todoistApiToken: 'tok',
      dryrun: false,
    };

    await runInboundPass(client, db.asD1(), FRAME_ID, deps);

    const mutatingCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE' || opts?.method === 'POST'
    );
    // No roll should have happened
    expect(mutatingCalls).toHaveLength(0);

    // Old row still exists
    expect(db.getRow(RECURRING_TASK_ID, RECURRING_OCCURRENCE_DATE)).toBeDefined();
  });
});

describe('Phase 2b: inbound device-complete of recurring occurrence (§5)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function seedRecurringActiveRow(
    db: InMemoryD1,
    overrides: Partial<MappingRow> = {}
  ): MappingRow {
    const expected_summary = buildSummary('Take out trash', RECURRING_TASK_ID);
    const row: MappingRow = {
      todoist_id: RECURRING_TASK_ID,
      fp_stable_id: null,
      occurrence_date: RECURRING_OCCURRENCE_DATE,
      surface: 'chore',
      frame_id: FRAME_ID,
      profile: PROFILE,
      skylight_id: 'sky-recur-001',
      expected_summary,
      last_pushed_status: 'pending',
      observed_status: 'pending',
      last_pushed_hash: fingerprint(
        makeRecurringTodoistTask(RECURRING_TASK_ID, RECURRING_OCCURRENCE_DATE) as import('./types.js').RawTask,
        PROFILE
      ),
      state: 'active',
      idem_token: sentinelToken(RECURRING_TASK_ID),
      updated_at: null,
      ...overrides,
    };
    db.rows.set(`${row.todoist_id}:${row.occurrence_date}`, row as unknown as D1Row);
    return row;
  }

  it('(2b-2) device completes recurring occurrence → closes Todoist (advance) AND rolls (DRYRUN gates both)', async () => {
    const db = new InMemoryD1();
    seedRecurringActiveRow(db);
    const expectedSummary = buildSummary('Take out trash', RECURRING_TASK_ID);

    // GET chore → complete (device completed it)
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => makeChoreResponse('sky-recur-001', expectedSummary, 'complete'),
      text: async () => JSON.stringify(makeChoreResponse('sky-recur-001', expectedSummary, 'complete')),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: true, token: 'tok' });

    const closedTaskIds: string[] = [];
    const deps: InboundPassDeps = {
      getTaskFn: async (id) =>
        makeRecurringTodoistTask(id, RECURRING_OCCURRENCE_DATE) as import('./types.js').RawTask,
      closeTaskFn: async (id) => { closedTaskIds.push(id); },
      getTaskAfterCloseFn: async (id) =>
        makeRecurringTodoistTask(id, NEXT_OCCURRENCE_DATE) as import('./types.js').RawTask,
      todoistApiToken: 'tok',
      dryrun: true,
      profileCategoryMap: { kyle: 'cat-001' },
      timezone: 'America/New_York',
    };

    await runInboundPass(client, db.asD1(), FRAME_ID, deps);

    // DRYRUN: no close call to Todoist
    expect(closedTaskIds).toHaveLength(0);

    // DRYRUN: no DELETE/POST to Skylight
    const mutatingCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE' || opts?.method === 'POST' || opts?.method === 'PUT'
    );
    expect(mutatingCalls).toHaveLength(0);

    // D1: last_pushed_status updated to 'complete'
    const row = db.getRow(RECURRING_TASK_ID, RECURRING_OCCURRENCE_DATE);
    expect(row?.last_pushed_status).toBe('complete');
  });

  it('(2b-2-live) device completes recurring occurrence → closes Todoist, deletes old, creates next occurrence', async () => {
    const db = new InMemoryD1();
    seedRecurringActiveRow(db);
    const expectedSummary = buildSummary('Take out trash', RECURRING_TASK_ID);

    // Sequence:
    // 1. GET chore → complete (inbound sees device completed)
    // 2. GET (delete re-confirm)
    // 3. DELETE old chore
    // 4. GET verify-deleted 404
    // 5. POST create new occurrence
    // 6. GET read-back new
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeChoreResponse('sky-recur-001', expectedSummary, 'complete'),
        text: async () => JSON.stringify(makeChoreResponse('sky-recur-001', expectedSummary, 'complete')),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeChoreResponse('sky-recur-001', expectedSummary, 'complete'),
        text: async () => JSON.stringify(makeChoreResponse('sky-recur-001', expectedSummary, 'complete')),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 204,
        text: async () => '',
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: false, status: 404,
        text: async () => 'Not Found',
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeCreateResponse('sky-recur-002', expectedSummary),
        text: async () => JSON.stringify(makeCreateResponse('sky-recur-002', expectedSummary)),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeChoreResponse('sky-recur-002', expectedSummary),
        text: async () => JSON.stringify(makeChoreResponse('sky-recur-002', expectedSummary)),
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    const closedTaskIds: string[] = [];
    const deps: InboundPassDeps = {
      getTaskFn: async (id) =>
        makeRecurringTodoistTask(id, RECURRING_OCCURRENCE_DATE) as import('./types.js').RawTask,
      closeTaskFn: async (id) => { closedTaskIds.push(id); },
      getTaskAfterCloseFn: async (id) =>
        makeRecurringTodoistTask(id, NEXT_OCCURRENCE_DATE) as import('./types.js').RawTask,
      todoistApiToken: 'tok',
      dryrun: false,
      profileCategoryMap: {},
      timezone: 'America/New_York',
    };

    await runInboundPass(client, db.asD1(), FRAME_ID, deps);

    // closeTaskFn was called to advance Todoist
    expect(closedTaskIds).toContain(RECURRING_TASK_ID);

    // Old occurrence row should be gone
    expect(db.getRow(RECURRING_TASK_ID, RECURRING_OCCURRENCE_DATE)).toBeUndefined();

    // New occurrence row should exist
    const newRow = db.getRow(RECURRING_TASK_ID, NEXT_OCCURRENCE_DATE);
    expect(newRow).toBeDefined();
    expect(newRow?.state).toBe('active');
    expect(newRow?.skylight_id).toBe('sky-recur-002');

    // A DELETE was issued for the old chore and a POST for the new one
    const deleteCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE'
    );
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(deleteCalls).toHaveLength(1);
    expect(postCalls).toHaveLength(1);
  });

  it('(2b-5) echo guard: fresh pending occurrence after roll is not re-completed', async () => {
    // After a roll, the new occurrence is 'pending' and last_pushed_status='pending'.
    // A subsequent inbound pass should see observed=pending == last_pushed=pending → echo → NOOP.
    const db = new InMemoryD1();
    const expectedSummary = buildSummary('Take out trash', RECURRING_TASK_ID);

    // Seed the NEW (post-roll) occurrence row as active pending
    const newRow: MappingRow = {
      todoist_id: RECURRING_TASK_ID,
      fp_stable_id: null,
      occurrence_date: NEXT_OCCURRENCE_DATE,
      surface: 'chore',
      frame_id: FRAME_ID,
      profile: PROFILE,
      skylight_id: 'sky-recur-002',
      expected_summary: expectedSummary,
      last_pushed_status: 'pending',
      observed_status: 'pending',
      last_pushed_hash: fingerprint(
        makeRecurringTodoistTask(RECURRING_TASK_ID, NEXT_OCCURRENCE_DATE) as import('./types.js').RawTask,
        PROFILE
      ),
      state: 'active',
      idem_token: sentinelToken(RECURRING_TASK_ID),
      updated_at: null,
    };
    db.rows.set(`${newRow.todoist_id}:${newRow.occurrence_date}`, newRow as unknown as D1Row);

    // GET chore → pending (not completed)
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => makeChoreResponse('sky-recur-002', expectedSummary, 'pending'),
      text: async () => JSON.stringify(makeChoreResponse('sky-recur-002', expectedSummary, 'pending')),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    const closedTaskIds: string[] = [];
    const deps: InboundPassDeps = {
      getTaskFn: async (id) =>
        makeRecurringTodoistTask(id, NEXT_OCCURRENCE_DATE) as import('./types.js').RawTask,
      closeTaskFn: async (id) => { closedTaskIds.push(id); },
      todoistApiToken: 'tok',
      dryrun: false,
    };

    await runInboundPass(client, db.asD1(), FRAME_ID, deps);

    // No close call — echo guard suppressed it
    expect(closedTaskIds).toHaveLength(0);

    // No mutating calls to Skylight
    const mutatingCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE' || opts?.method === 'POST' || opts?.method === 'PUT'
    );
    expect(mutatingCalls).toHaveLength(0);
  });

  it('(2b-6) frame-local occurrence_date boundary: occurrenceDate derived from task.due.date (not new Date() local)', () => {
    // §10: occurrence_date must come from task.due.date, not wall-clock.
    // This is a pure unit test verifying the helper.
    import('./reconcile.js').then(({ occurrenceDate }) => {
      const task = {
        id: 'test',
        content: 'x',
        description: '',
        labels: [],
        project_id: '',
        section_id: null,
        parent_id: null,
        due: { date: '2026-06-17', string: 'every day', is_recurring: true },
        priority: 1,
        checked: false,
      } as import('./types.js').RawTask;

      // Even if wall-clock says 2026-06-18, occurrenceDate returns task.due.date
      expect(occurrenceDate(task)).toBe('2026-06-17');

      // Non-recurring
      const task2 = { ...task, due: { date: '2026-01-15', string: 'Jan 15', is_recurring: false } };
      expect(occurrenceDate(task2)).toBe('2026-01-15');

      // No due
      const task3 = { ...task, due: null };
      expect(occurrenceDate(task3)).toBe('');
    });
  });
});

// ===========================================================================
// Phase 2c: Lists surface tests
// ===========================================================================

// ---------------------------------------------------------------------------
// KV mock helper
// ---------------------------------------------------------------------------

function makeKvMock(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    list: async () => ({ keys: [], list_complete: true, caret: null }),
    getWithMetadata: async (key: string) => ({ value: store.get(key) ?? null, metadata: null }),
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// List response helpers
// ---------------------------------------------------------------------------

function makeListsResponse(lists: Array<{ id: string; label: string; color?: string }>) {
  return {
    data: lists.map((l) => ({
      id: l.id,
      type: 'list',
      attributes: { label: l.label, kind: 'to_do', color: l.color ?? '#B6E085' },
    })),
  };
}

function makeCreateListResponse(id: string, label: string) {
  return {
    data: { id, type: 'list', attributes: { label, kind: 'to_do', color: '#B6E085' } },
  };
}

function makeSingleListResponse(listId: string, items: Array<{ id: string; label: string; status?: string }>) {
  return {
    data: { id: listId, type: 'list', attributes: { label: BRIDGE_LIST_LABEL, kind: 'to_do', color: '#B6E085' } },
    included: items.map((i) => ({
      id: i.id,
      type: 'list_item',
      attributes: {
        label: i.label,
        status: i.status ?? 'pending',
        section: null,
        position: null,
        created_at: null,
      },
    })),
  };
}

function makeCreateListItemResponse(id: string, label: string) {
  return {
    data: { id, type: 'list_item', attributes: { label, status: 'pending', section: null, position: null, created_at: null } },
  };
}

const BRIDGE_LIST_ID = 'bridge-list-001';
const LIST_TASK_ID = 'task-nodue12345';
const LIST_TASK_CONTENT = 'Buy groceries';

function makeNoDueTask(id = LIST_TASK_ID, checked = false) {
  return {
    id,
    content: LIST_TASK_CONTENT,
    description: '',
    labels: [],
    project_id: 'proj-1',
    section_id: null,
    parent_id: null,
    due: null,
    priority: 1,
    checked,
  };
}

function seedListRow(db: InMemoryD1, overrides: Partial<MappingRow> = {}): MappingRow {
  const label = buildListItemLabel(LIST_TASK_CONTENT, LIST_TASK_ID);
  const row: MappingRow = {
    todoist_id: LIST_TASK_ID,
    fp_stable_id: null,
    occurrence_date: '',
    surface: 'list',
    frame_id: FRAME_ID,
    profile: PROFILE,
    skylight_id: 'item-001',
    expected_summary: label,
    last_pushed_status: 'pending',
    observed_status: 'pending',
    last_pushed_hash: LIST_TASK_ID,
    state: 'active',
    idem_token: sentinelToken(LIST_TASK_ID),
    updated_at: null,
    ...overrides,
  };
  db.rows.set(`${row.todoist_id}:${row.occurrence_date}`, row as unknown as D1Row);
  return row;
}

// ---------------------------------------------------------------------------
// Phase 2c: Safety guard tests
// ---------------------------------------------------------------------------

describe('Phase 2c: assertBridgeListWrite (list write guard)', () => {
  it('throws ListWriteGuardError when target list id is a family list', () => {
    const familyId = '6454862'; // shopping list
    expect(() => assertBridgeListWrite(familyId, BRIDGE_LIST_ID)).toThrow(ListWriteGuardError);
    expect(() => assertBridgeListWrite(familyId, BRIDGE_LIST_ID)).toThrow(/SAFETY/);
  });

  it('throws ListWriteGuardError when target != bridge list id', () => {
    expect(() => assertBridgeListWrite('some-other-list', BRIDGE_LIST_ID)).toThrow(ListWriteGuardError);
  });

  it('does NOT throw when target == bridge list id and not a family list', () => {
    expect(() => assertBridgeListWrite(BRIDGE_LIST_ID, BRIDGE_LIST_ID)).not.toThrow();
  });

  it('FAMILY_LIST_IDS contains both real family lists', () => {
    expect(FAMILY_LIST_IDS.has('6454862')).toBe(true);
    expect(FAMILY_LIST_IDS.has('6454863')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 2c: ensureFairPlayList tests
// ---------------------------------------------------------------------------

describe('Phase 2c: ensureFairPlayList', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns cached id from KV without HTTP call', async () => {
    const kv = makeKvMock({ fairplay_list_id: BRIDGE_LIST_ID });
    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    const id = await ensureFairPlayList(client, kv, false);
    expect(id).toBe(BRIDGE_LIST_ID);
    // No HTTP calls needed
    expect(fetchSpy.mock.calls).toHaveLength(0);
  });

  it('creates the bridge list if not found, caches id, asserts not family list', async () => {
    const kv = makeKvMock(); // empty KV
    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    // GET /lists → empty (no bridge list yet)
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeListsResponse([{ id: 'family-list', label: 'Shopping', color: '#FF6B6B' }]),
        text: async () => JSON.stringify(makeListsResponse([{ id: 'family-list', label: 'Shopping', color: '#FF6B6B' }])),
        headers: { get: () => null },
      } as unknown as Response)
      // POST /lists → returns new bridge list id
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeCreateListResponse(BRIDGE_LIST_ID, BRIDGE_LIST_LABEL),
        text: async () => JSON.stringify(makeCreateListResponse(BRIDGE_LIST_ID, BRIDGE_LIST_LABEL)),
        headers: { get: () => null },
      } as unknown as Response);

    const id = await ensureFairPlayList(client, kv, false);
    expect(id).toBe(BRIDGE_LIST_ID);
    // Assert it's NOT a family list
    expect(FAMILY_LIST_IDS.has(id)).toBe(false);

    // Second call should return cached (no more HTTP)
    const kv2 = makeKvMock({ fairplay_list_id: BRIDGE_LIST_ID });
    const id2 = await ensureFairPlayList(client, kv2, false);
    expect(id2).toBe(BRIDGE_LIST_ID);
  });

  it('finds existing bridge list by label in GET /lists, caches it', async () => {
    const kv = makeKvMock();
    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    // GET /lists → bridge list already exists
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeListsResponse([
        { id: 'family-list', label: 'Shopping' },
        { id: BRIDGE_LIST_ID, label: BRIDGE_LIST_LABEL, color: '#B6E085' },
      ]),
      text: async () => JSON.stringify(makeListsResponse([
        { id: 'family-list', label: 'Shopping' },
        { id: BRIDGE_LIST_ID, label: BRIDGE_LIST_LABEL, color: '#B6E085' },
      ])),
      headers: { get: () => null },
    } as unknown as Response);

    const id = await ensureFairPlayList(client, kv, false);
    expect(id).toBe(BRIDGE_LIST_ID);
    // No POST (no create needed)
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(postCalls).toHaveLength(0);
  });

  it('DRYRUN: returns synthetic id, no POST', async () => {
    const kv = makeKvMock();
    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: true, token: 'tok' });

    // GET /lists → empty
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeListsResponse([]),
      text: async () => JSON.stringify(makeListsResponse([])),
      headers: { get: () => null },
    } as unknown as Response);

    const id = await ensureFairPlayList(client, kv, true);
    expect(id).toBe(DRYRUN_SYNTHETIC_LIST_ID);

    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(postCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 2c: runCreateListItemProtocol
// ---------------------------------------------------------------------------

describe('Phase 2c: runCreateListItemProtocol', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('(2c-1) creates a list item in the DEDICATED list (not family list), commits active row with returned id', async () => {
    const db = new InMemoryD1();
    const task = makeNoDueTask();
    const label = buildListItemLabel(task.content, task.id);
    const itemId = 'item-new-001';

    // POST → create list item
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeCreateListItemResponse(itemId, label),
        text: async () => JSON.stringify(makeCreateListItemResponse(itemId, label)),
        headers: { get: () => null },
      } as unknown as Response)
      // GET list (read-back verify)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeSingleListResponse(BRIDGE_LIST_ID, [{ id: itemId, label }]),
        text: async () => JSON.stringify(makeSingleListResponse(BRIDGE_LIST_ID, [{ id: itemId, label }])),
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runCreateListItemProtocol(client, db.asD1(), task, null, FRAME_ID, PROFILE, BRIDGE_LIST_ID, false);

    const row = db.getRow(task.id, '');
    expect(row).toBeDefined();
    expect(row?.state).toBe('active');
    expect(row?.skylight_id).toBe(itemId);
    expect(row?.surface).toBe('list');
    expect(row?.occurrence_date).toBe('');

    // Verify target list id is NOT a family list
    expect(FAMILY_LIST_IDS.has(BRIDGE_LIST_ID)).toBe(false);

    // POST was to the dedicated list, not a family list
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(postCalls).toHaveLength(1);
    const postUrl = postCalls[0][0] as string;
    expect(postUrl).toContain(BRIDGE_LIST_ID);
    expect(postUrl).not.toContain('6454862');
    expect(postUrl).not.toContain('6454863');
  });

  it('(2c-1-dryrun) DRYRUN: zero list/Todoist mutations', async () => {
    const db = new InMemoryD1();
    const task = makeNoDueTask();

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: true, token: 'tok' });

    await runCreateListItemProtocol(client, db.asD1(), task, null, FRAME_ID, PROFILE, BRIDGE_LIST_ID, true);

    const mutatingCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST' || opts?.method === 'PUT' || opts?.method === 'DELETE'
    );
    expect(mutatingCalls).toHaveLength(0);

    const row = db.getRow(task.id, '');
    expect(row?.state).toBe('active');
    expect(row?.skylight_id).toBe(DRYRUN_SYNTHETIC_LIST_ID);
    expect(row?.surface).toBe('list');
  });

  it('(2c-family-list-guard) refuses to write to a family list id', async () => {
    const db = new InMemoryD1();
    const task = makeNoDueTask();
    const familyListId = '6454862';
    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    // Should throw a ListWriteGuardError — family list write refused
    await expect(
      runCreateListItemProtocol(client, db.asD1(), task, null, FRAME_ID, PROFILE, familyListId, false)
    ).rejects.toThrow(ListWriteGuardError);

    // No mutations issued to Skylight
    const mutatingCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST' || opts?.method === 'PUT' || opts?.method === 'DELETE'
    );
    expect(mutatingCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 2c: runCompleteListItemProtocol
// ---------------------------------------------------------------------------

describe('Phase 2c: runCompleteListItemProtocol', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('(2c-2) Todoist complete → PUT {status:"completed"} on list item (NOT "complete")', async () => {
    const db = new InMemoryD1();
    const row = seedListRow(db);
    const label = buildListItemLabel(LIST_TASK_CONTENT, LIST_TASK_ID);

    // PUT complete item
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: async () => '{}',
        headers: { get: () => null },
      } as unknown as Response)
      // GET list (read-back verify) → item is "completed"
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-001', label, status: 'completed' }]),
        text: async () => JSON.stringify(makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-001', label, status: 'completed' }])),
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runCompleteListItemProtocol(client, db.asD1(), row, BRIDGE_LIST_ID, false);

    // Assert PUT body uses "completed" not "complete"
    const putCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'PUT'
    );
    expect(putCalls).toHaveLength(1);
    const putBody = JSON.parse(putCalls[0][1]?.body as string) as { status: string };
    expect(putBody.status).toBe('completed'); // "completed" not "complete"

    const finalRow = db.getRow(LIST_TASK_ID, '');
    expect(finalRow?.last_pushed_status).toBe('complete');
  });

  it('(2c-2-dryrun) DRYRUN: zero mutations, last_pushed_status still updated', async () => {
    const db = new InMemoryD1();
    const row = seedListRow(db);
    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: true, token: 'tok' });

    await runCompleteListItemProtocol(client, db.asD1(), row, BRIDGE_LIST_ID, true);

    const mutatingCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'PUT' || opts?.method === 'POST' || opts?.method === 'DELETE'
    );
    expect(mutatingCalls).toHaveLength(0);

    const finalRow = db.getRow(LIST_TASK_ID, '');
    expect(finalRow?.last_pushed_status).toBe('complete');
  });
});

// ---------------------------------------------------------------------------
// Phase 2c: runDeleteListItemProtocol
// ---------------------------------------------------------------------------

describe('Phase 2c: runDeleteListItemProtocol', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('(2c-3) deletes list item from bridge list, hard-deletes D1 row', async () => {
    const db = new InMemoryD1();
    const row = seedListRow(db);
    const label = buildListItemLabel(LIST_TASK_CONTENT, LIST_TASK_ID);

    // GET list before delete → item exists
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-001', label }]),
        text: async () => JSON.stringify(makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-001', label }])),
        headers: { get: () => null },
      } as unknown as Response)
      // DELETE
      .mockResolvedValueOnce({
        ok: true, status: 204,
        text: async () => '',
        headers: { get: () => null },
      } as unknown as Response)
      // GET list after delete → item gone
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeSingleListResponse(BRIDGE_LIST_ID, []),
        text: async () => JSON.stringify(makeSingleListResponse(BRIDGE_LIST_ID, [])),
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runDeleteListItemProtocol(client, db.asD1(), row, BRIDGE_LIST_ID, false);

    // D1 row should be gone
    expect(db.getRow(LIST_TASK_ID, '')).toBeUndefined();

    // A DELETE was issued
    const deleteCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE'
    );
    expect(deleteCalls).toHaveLength(1);
  });

  it('(2c-3-dryrun) DRYRUN: no DELETE, D1 row hard-deleted anyway', async () => {
    const db = new InMemoryD1();
    const row = seedListRow(db);
    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: true, token: 'tok' });

    await runDeleteListItemProtocol(client, db.asD1(), row, BRIDGE_LIST_ID, true);

    const deleteCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE'
    );
    expect(deleteCalls).toHaveLength(0);

    // D1 row should still be hard-deleted (DRYRUN only skips HTTP)
    expect(db.getRow(LIST_TASK_ID, '')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 2c: runInboundListPoll (device-completed list items → close Todoist)
// ---------------------------------------------------------------------------

describe('Phase 2c: runInboundListPoll', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('(2c-4) device completes list item → closes Todoist task', async () => {
    const db = new InMemoryD1();
    seedListRow(db, { last_pushed_status: 'pending', observed_status: 'pending' });
    const label = buildListItemLabel(LIST_TASK_CONTENT, LIST_TASK_ID);

    // GET list → item is "completed"
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-001', label, status: 'completed' }]),
      text: async () => JSON.stringify(makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-001', label, status: 'completed' }])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const closedTaskIds: string[] = [];
    const deps: InboundPassDeps = {
      getTaskFn: async (id) => makeNoDueTask(id, false) as import('./types.js').RawTask,
      closeTaskFn: async (id) => { closedTaskIds.push(id); },
      todoistApiToken: 'tok-todoist',
      dryrun: false,
    };

    await runInboundListPoll(client, db.asD1(), FRAME_ID, BRIDGE_LIST_ID, deps);

    // Todoist task was closed
    expect(closedTaskIds).toContain(LIST_TASK_ID);

    // last_pushed_status updated
    const row = db.getRow(LIST_TASK_ID, '');
    expect(row?.last_pushed_status).toBe('complete');
  });

  it('(2c-4-dryrun) DRYRUN: device completes list item → zero Todoist mutations', async () => {
    const db = new InMemoryD1();
    seedListRow(db, { last_pushed_status: 'pending' });
    const label = buildListItemLabel(LIST_TASK_CONTENT, LIST_TASK_ID);

    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-001', label, status: 'completed' }]),
      text: async () => JSON.stringify(makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-001', label, status: 'completed' }])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: true, token: 'tok' });
    const closedTaskIds: string[] = [];
    const deps: InboundPassDeps = {
      getTaskFn: async (id) => makeNoDueTask(id, false) as import('./types.js').RawTask,
      closeTaskFn: async (id) => { closedTaskIds.push(id); },
      todoistApiToken: 'tok-todoist',
      dryrun: true,
    };

    await runInboundListPoll(client, db.asD1(), FRAME_ID, BRIDGE_LIST_ID, deps);

    // DRYRUN: no close to Todoist
    expect(closedTaskIds).toHaveLength(0);

    // last_pushed_status still updated in D1
    const row = db.getRow(LIST_TASK_ID, '');
    expect(row?.last_pushed_status).toBe('complete');
  });

  it('(2c-4-echo) echo guard: already-pushed completed item is not re-closed', async () => {
    const db = new InMemoryD1();
    // last_pushed_status='complete' means we already pushed this
    seedListRow(db, { last_pushed_status: 'complete' });
    const label = buildListItemLabel(LIST_TASK_CONTENT, LIST_TASK_ID);

    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-001', label, status: 'completed' }]),
      text: async () => JSON.stringify(makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-001', label, status: 'completed' }])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const closedTaskIds: string[] = [];
    const deps: InboundPassDeps = {
      getTaskFn: async (id) => makeNoDueTask(id, false) as import('./types.js').RawTask,
      closeTaskFn: async (id) => { closedTaskIds.push(id); },
      todoistApiToken: 'tok-todoist',
      dryrun: false,
    };

    await runInboundListPoll(client, db.asD1(), FRAME_ID, BRIDGE_LIST_ID, deps);

    // Echo: we already pushed this, don't close again
    expect(closedTaskIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 2c: Surface migration tests
// ---------------------------------------------------------------------------

describe('Phase 2c: runMigrateSurfaceProtocol (surface migration)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('(2c-migrate-list-to-chore) task gains due date: deletes list item, creates chore (no dup/orphan)', async () => {
    const db = new InMemoryD1();
    const row = seedListRow(db);
    const label = buildListItemLabel(LIST_TASK_CONTENT, LIST_TASK_ID);
    const choreSummary = buildSummary(LIST_TASK_CONTENT, LIST_TASK_ID);

    // Sequence:
    // 1. GET list before delete (item exists)
    // 2. DELETE item
    // 3. GET list after delete (item gone)
    // 4. POST create chore
    // 5. GET read-back chore
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-001', label }]),
        text: async () => JSON.stringify(makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-001', label }])),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 204,
        text: async () => '',
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeSingleListResponse(BRIDGE_LIST_ID, []),
        text: async () => JSON.stringify(makeSingleListResponse(BRIDGE_LIST_ID, [])),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeCreateResponse('sky-chore-001', choreSummary),
        text: async () => JSON.stringify(makeCreateResponse('sky-chore-001', choreSummary)),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeChoreResponse('sky-chore-001', choreSummary),
        text: async () => JSON.stringify(makeChoreResponse('sky-chore-001', choreSummary)),
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const task = { ...makeNoDueTask(), due: { date: '2026-06-25' } };

    await runMigrateSurfaceProtocol(
      client, db.asD1(), row, task,
      'list', 'chore',
      FRAME_ID, PROFILE, null, BRIDGE_LIST_ID, false, 'America/New_York'
    );

    // Old list row should be gone
    expect(db.getRow(LIST_TASK_ID, '')).toBeUndefined();

    // New chore row should exist (keyed by due date as occurrence_date)
    const choreRow = db.getRow(LIST_TASK_ID, '2026-06-25');
    expect(choreRow).toBeDefined();
    expect(choreRow?.surface).toBe('chore');
    expect(choreRow?.state).toBe('active');
    expect(choreRow?.skylight_id).toBe('sky-chore-001');

    // Exactly 1 DELETE + 1 POST
    const deleteCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE'
    );
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(deleteCalls).toHaveLength(1);
    expect(postCalls).toHaveLength(1);
  });

  it('(2c-migrate-chore-to-list) task loses due date: deletes chore, creates list item (no dup/orphan)', async () => {
    const db = new InMemoryD1();
    // Seed a chore row for the same task id
    const choreSummary = buildSummary(LIST_TASK_CONTENT, LIST_TASK_ID);
    const choreRow: MappingRow = {
      todoist_id: LIST_TASK_ID,
      fp_stable_id: null,
      occurrence_date: '2026-06-20',
      surface: 'chore',
      frame_id: FRAME_ID,
      profile: PROFILE,
      skylight_id: 'sky-chore-001',
      expected_summary: choreSummary,
      last_pushed_status: 'pending',
      observed_status: 'pending',
      last_pushed_hash: LIST_TASK_ID,
      state: 'active',
      idem_token: sentinelToken(LIST_TASK_ID),
      updated_at: null,
    };
    db.rows.set(`${choreRow.todoist_id}:${choreRow.occurrence_date}`, choreRow as unknown as D1Row);

    const label = buildListItemLabel(LIST_TASK_CONTENT, LIST_TASK_ID);

    // Sequence:
    // 1. GET chore (delete re-confirm)
    // 2. DELETE chore
    // 3. GET chore verify-deleted 404
    // 4. POST create list item
    // 5. GET list (read-back)
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeChoreResponse('sky-chore-001', choreSummary),
        text: async () => JSON.stringify(makeChoreResponse('sky-chore-001', choreSummary)),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 204,
        text: async () => '',
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: false, status: 404,
        text: async () => 'Not Found',
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeCreateListItemResponse('item-new-001', label),
        text: async () => JSON.stringify(makeCreateListItemResponse('item-new-001', label)),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-new-001', label }]),
        text: async () => JSON.stringify(makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-new-001', label }])),
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const task = makeNoDueTask(); // no due date

    await runMigrateSurfaceProtocol(
      client, db.asD1(), choreRow, task,
      'chore', 'list',
      FRAME_ID, PROFILE, null, BRIDGE_LIST_ID, false, 'America/New_York'
    );

    // Old chore row should be gone
    expect(db.getRow(LIST_TASK_ID, '2026-06-20')).toBeUndefined();

    // New list item row should exist (occurrence_date='')
    const listRow = db.getRow(LIST_TASK_ID, '');
    expect(listRow).toBeDefined();
    expect(listRow?.surface).toBe('list');
    expect(listRow?.state).toBe('active');
    expect(listRow?.skylight_id).toBe('item-new-001');

    // Exactly 1 DELETE + 1 POST
    const deleteCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE'
    );
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(deleteCalls).toHaveLength(1);
    expect(postCalls).toHaveLength(1);
  });
});
