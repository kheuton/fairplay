/**
 * Tests for runOutboundPass and runOrphanSweep (index.ts orchestration).
 *
 * These tests call the REAL exported functions from index.ts.
 * todoist-client.fetchDeckTasks is mocked at the module level so we can
 * control which tasks the outbound pass sees without hitting real Todoist.
 *
 * Critical cases (blocker + major findings):
 *   (OB-1) Active in-sync row → zero DELETE/PUT/POST (blocker: outbound must NOT
 *           destroy healthy chores by misreading null observedChore as 404)
 *   (OB-2) No existing row → CREATE_CHORE path still works
 *   (OB-3) runOrphanSweep with 'deleting' row whose chore is 404 → hard-deletes D1 row
 *   (OB-4) runOrphanSweep with 'deleting' row whose chore still exists → resumes delete protocol
 *   (OB-5) runOrphanSweep with no deleting rows → no fetch issued
 *   (OB-6) Surface migration chore→list dispatched via runOutboundPass (task loses due date)
 *   (OB-7) Surface migration list→chore dispatched via runOutboundPass (task gains due date)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MappingRow } from './types.js';
import {
  buildSummary,
  sentinelToken,
  DRYRUN_SYNTHETIC_ID,
  SkylightClient,
} from './skylight-client.js';
import { buildListItemLabel } from './index.js';
import { fingerprint } from './reconcile.js';
import {
  runOutboundPass,
  runOrphanSweep,
} from './index.js';

// ---------------------------------------------------------------------------
// Module mock: fetchDeckTasks
// ---------------------------------------------------------------------------

// We mock the whole todoist-client module so fetchDeckTasks returns controlled data.
// vi.mock is hoisted by Vitest before imports, which is what we want.
vi.mock('./todoist-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./todoist-client.js')>();
  return {
    ...actual,
    fetchDeckTasks: vi.fn().mockResolvedValue([]),
  };
});

import { fetchDeckTasks } from './todoist-client.js';
const mockFetchDeckTasks = fetchDeckTasks as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Minimal in-memory D1 mock (mirrors index.test.ts)
// ---------------------------------------------------------------------------

interface D1Row extends Record<string, unknown> {}

class InMemoryD1 {
  rows = new Map<string, D1Row>();

  getRow(todoistId: string, occurrenceDate: string): D1Row | undefined {
    return this.rows.get(`${todoistId}:${occurrenceDate}`);
  }

  allRows(): D1Row[] {
    return [...this.rows.values()];
  }

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
          if (sql.includes("WHERE state = 'active'")) {
            const results = [...self.rows.values()].filter((r) => r.state === 'active') as T[];
            return { results, success: true, meta: {} };
          }
          if (sql.includes("WHERE state = 'deleting'")) {
            const results = [...self.rows.values()].filter((r) => r.state === 'deleting') as T[];
            return { results, success: true, meta: {} };
          }
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
// Shared fixtures
// ---------------------------------------------------------------------------

const TASK_ID = 'task-outbound1';
const TASK_CONTENT = 'Clean kitchen';
const OCCURRENCE_DATE = '2026-06-25';
const FRAME_ID = 'frame-test';
const PROFILE = 'kyle';

function makeChoreResponse(id: string, summary: string, status = 'pending') {
  return {
    data: {
      id,
      type: 'chore' as const,
      attributes: {
        summary,
        status,
        start: OCCURRENCE_DATE,
        start_time: null,
        recurring: false,
        completed_on: null,
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
          start: OCCURRENCE_DATE,
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

function makeRawTask(overrides: Partial<{
  id: string; content: string; checked: boolean;
  due: { date: string; string: string; is_recurring: boolean } | null;
}> = {}) {
  return {
    id: TASK_ID,
    content: TASK_CONTENT,
    description: '',
    labels: [],
    project_id: 'proj-1',
    section_id: null,
    parent_id: null,
    due: { date: OCCURRENCE_DATE, string: 'Jun 25', is_recurring: false },
    priority: 1,
    checked: false,
    ...overrides,
  };
}

function seedActiveRow(db: InMemoryD1, overrides: Partial<MappingRow> = {}): MappingRow {
  const task = makeRawTask();
  const expected_summary = buildSummary(TASK_CONTENT, TASK_ID);
  const row: MappingRow = {
    todoist_id: TASK_ID,
    fp_stable_id: null,
    occurrence_date: OCCURRENCE_DATE,
    surface: 'chore',
    frame_id: FRAME_ID,
    profile: PROFILE,
    skylight_id: 'sky-outbound-001',
    expected_summary,
    last_pushed_status: 'pending',
    observed_status: 'pending',
    last_pushed_hash: fingerprint(task as import('./types.js').RawTask, PROFILE),
    state: 'active',
    idem_token: sentinelToken(TASK_ID),
    updated_at: null,
    ...overrides,
  };
  db.rows.set(`${row.todoist_id}:${row.occurrence_date}`, row as unknown as D1Row);
  return row;
}

// ---------------------------------------------------------------------------
// makeEnv: minimal Env stub for runOutboundPass
// ---------------------------------------------------------------------------

function makeEnv(): import('./types.js').Env {
  return {
    DB: null as unknown as D1Database,
    KV: null as unknown as KVNamespace,
    TODOIST_API_TOKEN: 'tok-todoist',
    SKYLIGHT_EMAIL: '',
    SKYLIGHT_PASSWORD: '',
    FRAME: FRAME_ID,
    FRAME_CONFIRMED: '',
    DRYRUN: 'false',
    PROFILE_CATEGORY_MAP: '{}',
    FRAME_TIMEZONE: 'America/New_York',
  };
}

// ---------------------------------------------------------------------------
// Tests: runOutboundPass — blocker fix (healthy active row → zero writes)
// ---------------------------------------------------------------------------

describe('runOutboundPass — active in-sync row must not be deleted (blocker fix)', () => {
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
    mockFetchDeckTasks.mockReset();
  });

  it('(OB-1) active in-sync row: outbound pass issues zero DELETE/PUT/POST calls', async () => {
    // Seed a healthy active row for a task that is in sync
    const db = new InMemoryD1();
    const row = seedActiveRow(db);

    // fetchDeckTasks returns the matching task (unchanged due date, not checked)
    const task = makeRawTask();
    mockFetchDeckTasks.mockResolvedValue([task]);

    // No Skylight fetch responses needed — outbound pass must not issue any GETs for this row
    // (it only does GETs during create read-back or roll, not for in-sync rows)
    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const env = makeEnv();

    await runOutboundPass(client, db.asD1(), env, FRAME_ID, PROFILE, null, 'America/New_York');

    // CRITICAL: zero DELETE, PUT, or POST calls must be issued for a healthy active row
    const mutatingCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE' || opts?.method === 'PUT' || opts?.method === 'POST'
    );
    expect(mutatingCalls).toHaveLength(0);

    // D1 row must still be 'active' (not 'deleting' or deleted)
    const finalRow = db.getRow(TASK_ID, OCCURRENCE_DATE);
    expect(finalRow).toBeDefined();
    expect(finalRow?.state).toBe('active');
    expect(finalRow?.skylight_id).toBe('sky-outbound-001');
  });

  it('(OB-2) no existing row → outbound pass creates a chore (basic create path)', async () => {
    const db = new InMemoryD1();
    const task = makeRawTask();
    const expectedSummary = buildSummary(task.content, task.id);

    mockFetchDeckTasks.mockResolvedValue([task]);

    // POST → create; GET → read-back
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeCreateResponse('sky-new-001', expectedSummary),
        text: async () => JSON.stringify(makeCreateResponse('sky-new-001', expectedSummary)),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeChoreResponse('sky-new-001', expectedSummary),
        text: async () => JSON.stringify(makeChoreResponse('sky-new-001', expectedSummary)),
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const env = makeEnv();

    await runOutboundPass(client, db.asD1(), env, FRAME_ID, PROFILE, null, 'America/New_York');

    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(postCalls).toHaveLength(1);

    const newRow = db.getRow(TASK_ID, OCCURRENCE_DATE);
    expect(newRow?.state).toBe('active');
    expect(newRow?.skylight_id).toBe('sky-new-001');
  });
});

// ---------------------------------------------------------------------------
// Tests: runOrphanSweep — major fix (stale 'deleting' rows cleaned up)
// ---------------------------------------------------------------------------

describe('runOrphanSweep — stale deleting rows (major fix)', () => {
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

  it('(OB-3) deleting row with chore already 404 → hard-deletes D1 row, zero non-GET calls', async () => {
    const db = new InMemoryD1();
    const expectedSummary = buildSummary(TASK_CONTENT, TASK_ID);

    // Seed a 'deleting' orphan row (chore already deleted on Skylight but row not cleaned up)
    const deletingRow: MappingRow = {
      todoist_id: TASK_ID,
      fp_stable_id: null,
      occurrence_date: OCCURRENCE_DATE,
      surface: 'chore',
      frame_id: FRAME_ID,
      profile: PROFILE,
      skylight_id: 'sky-orphan-001',
      expected_summary: expectedSummary,
      last_pushed_status: 'pending',
      observed_status: 'pending',
      last_pushed_hash: null,
      state: 'deleting',
      idem_token: sentinelToken(TASK_ID),
      updated_at: null,
    };
    db.rows.set(`${TASK_ID}:${OCCURRENCE_DATE}`, deletingRow as unknown as D1Row);

    // GET chore → 404 (chore was already deleted)
    fetchSpy.mockResolvedValue({
      ok: false, status: 404,
      text: async () => 'Not Found',
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runOrphanSweep(client, db.asD1(), FRAME_ID);

    // D1 row must be hard-deleted
    expect(db.getRow(TASK_ID, OCCURRENCE_DATE)).toBeUndefined();

    // Only GETs should have been issued (one GET to check if chore exists)
    const nonGetCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method !== undefined && opts?.method !== 'GET'
    );
    expect(nonGetCalls).toHaveLength(0);
  });

  it('(OB-4) deleting row with chore still existing → resumes delete protocol (DELETE issued, row cleaned up)', async () => {
    const db = new InMemoryD1();
    const expectedSummary = buildSummary(TASK_CONTENT, TASK_ID);

    // Seed a 'deleting' orphan row where the chore still exists
    const deletingRow: MappingRow = {
      todoist_id: TASK_ID,
      fp_stable_id: null,
      occurrence_date: OCCURRENCE_DATE,
      surface: 'chore',
      frame_id: FRAME_ID,
      profile: PROFILE,
      skylight_id: 'sky-orphan-002',
      expected_summary: expectedSummary,
      last_pushed_status: 'pending',
      observed_status: 'pending',
      last_pushed_hash: null,
      state: 'deleting',
      idem_token: sentinelToken(TASK_ID),
      updated_at: null,
    };
    db.rows.set(`${TASK_ID}:${OCCURRENCE_DATE}`, deletingRow as unknown as D1Row);

    // Sequence:
    // 1. GET in runOrphanSweep → chore exists
    // 2. GET in runDeleteProtocol (re-GET step 1) → chore exists with matching summary
    // 3. DELETE
    // 4. GET verify-deleted → 404
    fetchSpy
      .mockResolvedValueOnce({
        // sweep check: chore still exists
        ok: true, status: 200,
        json: async () => makeChoreResponse('sky-orphan-002', expectedSummary),
        text: async () => JSON.stringify(makeChoreResponse('sky-orphan-002', expectedSummary)),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        // delete protocol re-GET: chore exists with matching summary
        ok: true, status: 200,
        json: async () => makeChoreResponse('sky-orphan-002', expectedSummary),
        text: async () => JSON.stringify(makeChoreResponse('sky-orphan-002', expectedSummary)),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        // DELETE response
        ok: true, status: 204,
        text: async () => '',
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        // verify-deleted: 404
        ok: false, status: 404,
        text: async () => 'Not Found',
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runOrphanSweep(client, db.asD1(), FRAME_ID);

    // Exactly one DELETE was issued
    const deleteCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE'
    );
    expect(deleteCalls).toHaveLength(1);

    // D1 row must be hard-deleted after successful sweep
    expect(db.getRow(TASK_ID, OCCURRENCE_DATE)).toBeUndefined();
  });

  it('(OB-5) no deleting rows → orphan sweep issues zero fetches', async () => {
    const db = new InMemoryD1();
    // Only seed an active row (not deleting)
    seedActiveRow(db);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runOrphanSweep(client, db.asD1(), FRAME_ID);

    // No fetches at all — nothing to sweep
    expect(fetchSpy.mock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 2c surface migration response helpers
// ---------------------------------------------------------------------------

const BRIDGE_LIST_ID = 'bridge-list-outbound-001';
const LIST_TASK_CONTENT = 'Clean kitchen';

/** Build the list-item-style GET /lists/{id} response. */
function makeSingleListResponse(
  listId: string,
  items: Array<{ id: string; label: string; status?: string }>
) {
  return {
    data: {
      id: listId,
      type: 'list',
      attributes: { label: '▸ FairPlay', kind: 'to_do', color: '#B6E085' },
    },
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

/** POST /lists/{id}/list_items create response */
function makeCreateListItemResponse(id: string, label: string) {
  return {
    data: {
      id,
      type: 'list_item',
      attributes: { label, status: 'pending', section: null, position: null, created_at: null },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: runOutboundPass — surface migration dispatched end-to-end (blocker fix)
// ---------------------------------------------------------------------------

describe('runOutboundPass — surface migration dispatch (blocker fix)', () => {
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
    mockFetchDeckTasks.mockReset();
  });

  it('(OB-6) chore→list: task loses due date → runOutboundPass deletes old chore and creates list item (1 DELETE + 1 POST, old row gone, new list row active)', async () => {
    // Task now has NO due date (list surface) but old row is a chore
    const db = new InMemoryD1();
    const taskId = TASK_ID;
    const choreSummary = buildSummary(TASK_CONTENT, taskId);
    const OLD_OCC_DATE = '2026-06-25';

    // Seed an active chore row with occurrence_date='2026-06-25'
    const choreRow: MappingRow = {
      todoist_id: taskId,
      fp_stable_id: null,
      occurrence_date: OLD_OCC_DATE,
      surface: 'chore',
      frame_id: FRAME_ID,
      profile: PROFILE,
      skylight_id: 'sky-migrate-001',
      expected_summary: choreSummary,
      last_pushed_status: 'pending',
      observed_status: 'pending',
      last_pushed_hash: null,
      state: 'active',
      idem_token: sentinelToken(taskId),
      updated_at: null,
    };
    db.rows.set(`${taskId}:${OLD_OCC_DATE}`, choreRow as unknown as D1Row);

    // Task now has NO due date → outbound sees it as list surface
    const noDueTask = makeRawTask({ due: null });
    mockFetchDeckTasks.mockResolvedValue([noDueTask]);

    const label = buildListItemLabel(TASK_CONTENT, taskId);

    // HTTP sequence (chore→list migration):
    // 1. GET chore (delete re-confirm in runDeleteProtocol)
    // 2. DELETE chore
    // 3. GET chore verify-deleted → 404
    // 4. POST create list item
    // 5. GET list (read-back verify)
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeChoreResponse('sky-migrate-001', choreSummary),
        text: async () => JSON.stringify(makeChoreResponse('sky-migrate-001', choreSummary)),
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
        json: async () => makeCreateListItemResponse('item-migrate-001', label),
        text: async () => JSON.stringify(makeCreateListItemResponse('item-migrate-001', label)),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-migrate-001', label }]),
        text: async () => JSON.stringify(makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-migrate-001', label }])),
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const env = makeEnv();

    await runOutboundPass(client, db.asD1(), env, FRAME_ID, PROFILE, null, 'America/New_York', BRIDGE_LIST_ID);

    // Old chore row MUST be gone (not orphaned)
    expect(db.getRow(taskId, OLD_OCC_DATE)).toBeUndefined();

    // New list row MUST exist at occurrence_date=''
    const newListRow = db.getRow(taskId, '');
    expect(newListRow).toBeDefined();
    expect(newListRow?.surface).toBe('list');
    expect(newListRow?.state).toBe('active');
    expect(newListRow?.skylight_id).toBe('item-migrate-001');

    // Exactly 1 DELETE and 1 POST
    const deleteCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE'
    );
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(deleteCalls).toHaveLength(1);
    expect(postCalls).toHaveLength(1);

    // Total D1 rows: only the new list row (old chore row deleted, no duplicates)
    expect(db.allRows().filter((r) => r.todoist_id === taskId)).toHaveLength(1);
  });

  it('(OB-7) list→chore: task gains due date → runOutboundPass deletes old list item and creates chore (1 DELETE + 1 POST, old row gone, new chore row active)', async () => {
    // Task now HAS a due date (chore surface) but old row is a list item
    const db = new InMemoryD1();
    const taskId = TASK_ID;
    const label = buildListItemLabel(TASK_CONTENT, taskId);
    const choreSummary = buildSummary(TASK_CONTENT, taskId);

    // Seed an active list row with occurrence_date=''
    const listRow: MappingRow = {
      todoist_id: taskId,
      fp_stable_id: null,
      occurrence_date: '',
      surface: 'list',
      frame_id: FRAME_ID,
      profile: PROFILE,
      skylight_id: 'item-migrate-002',
      expected_summary: label,
      last_pushed_status: 'pending',
      observed_status: 'pending',
      last_pushed_hash: taskId,
      state: 'active',
      idem_token: sentinelToken(taskId),
      updated_at: null,
    };
    db.rows.set(`${taskId}:`, listRow as unknown as D1Row);

    // Task now HAS a due date → outbound sees it as chore surface
    const dueTask = makeRawTask({ due: { date: OCCURRENCE_DATE, string: 'Jun 25', is_recurring: false } });
    mockFetchDeckTasks.mockResolvedValue([dueTask]);

    // HTTP sequence (list→chore migration):
    // 1. GET list before delete (verify item exists)
    // 2. DELETE list item
    // 3. GET list after delete (verify item gone)
    // 4. POST create chore
    // 5. GET chore (read-back verify)
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-migrate-002', label }]),
        text: async () => JSON.stringify(makeSingleListResponse(BRIDGE_LIST_ID, [{ id: 'item-migrate-002', label }])),
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
        json: async () => makeCreateResponse('sky-migrate-002', choreSummary),
        text: async () => JSON.stringify(makeCreateResponse('sky-migrate-002', choreSummary)),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeChoreResponse('sky-migrate-002', choreSummary),
        text: async () => JSON.stringify(makeChoreResponse('sky-migrate-002', choreSummary)),
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const env = makeEnv();

    await runOutboundPass(client, db.asD1(), env, FRAME_ID, PROFILE, null, 'America/New_York', BRIDGE_LIST_ID);

    // Old list row MUST be gone (not orphaned)
    expect(db.getRow(taskId, '')).toBeUndefined();

    // New chore row MUST exist at occurrence_date=OCCURRENCE_DATE
    const newChoreRow = db.getRow(taskId, OCCURRENCE_DATE);
    expect(newChoreRow).toBeDefined();
    expect(newChoreRow?.surface).toBe('chore');
    expect(newChoreRow?.state).toBe('active');
    expect(newChoreRow?.skylight_id).toBe('sky-migrate-002');

    // Exactly 1 DELETE and 1 POST
    const deleteCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE'
    );
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(deleteCalls).toHaveLength(1);
    expect(postCalls).toHaveLength(1);

    // Total D1 rows: only the new chore row (old list row deleted, no duplicates)
    expect(db.allRows().filter((r) => r.todoist_id === taskId)).toHaveLength(1);
  });
});
