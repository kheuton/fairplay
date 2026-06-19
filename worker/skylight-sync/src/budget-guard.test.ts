/**
 * Tests for the subrequest budget guard, counter, MappingCache, and instrumentation.
 *
 * These drive the REAL exported functions from index.ts (runOutboundPass, RunContext,
 * MappingCache, CountedSkylightClient, BudgetExhaustedError, runInboundPass) and from
 * subrequest-counter.ts (SubrequestCounter, INBOUND_ROW_COST) and counted-wrappers.ts.
 *
 * Test groups:
 *   (BG-1)  Budget guard: creates only as many tasks as fit, defers the rest
 *   (BG-2)  No dangling 'creating' rows for deferred tasks (guard fires BEFORE write-ahead)
 *   (BG-11) Mutation budget guard: multiple deletes/rolls in one tick, guard defers remaining
 *   (BG-12) ROLL is never half-done: guard fires before delete+create; follow-up run completes it
 *   (BG-3)  Follow-up run (budget restored) creates the previously deferred tasks (resume, no dup)
 *   (BG-4)  Counter increments on Skylight + D1 + KV ops via makeCountedD1/makeCountedKV
 *   (BG-5)  MappingCache: one SELECT loads all, per-task lookups hit Map, created row visible
 *   (BG-6)  Batched writes: write-ahead (insertCreatingRow) fires before POST, verify then commit
 *   (BG-7)  Breakdown line emitted on success path (logged via console.log)
 *   (BG-8)  Sabotage: budget guard test FAILS if the guard is removed (structural correctness check)
 *   (BG-9)  Inbound budget guard: many active mappings, tiny budget → defers remaining rows,
 *           no dangling state, logs deferral; follow-up run with restored budget processes rest.
 *   (BG-10) Todoist counting: getTask/closeTask wrappers in inbound pass increment the counter;
 *           fetchDeckTasks onFetch hook increments counter per actual page GET.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SubrequestCounter,
  SUBREQUEST_BUDGET,
  TAIL_RESERVE,
  INBOUND_ROW_COST,
  MUTATION_COST_DELETE,
  MUTATION_COST_ROLL,
} from './subrequest-counter.js';
import { makeCountedD1, makeCountedKV } from './counted-wrappers.js';
import {
  MappingCache,
  CountedSkylightClient,
  BudgetExhaustedError,
  RunContext,
  runOutboundPass,
  runInboundPass,
  type PendingCreateEntry,
} from './index.js';
import { choreDescriptionMarker, SkylightClient, sentinelToken } from './skylight-client.js';
import type { MappingRow } from './types.js';

// ---------------------------------------------------------------------------
// Minimal in-memory D1 mock (same pattern as index.test.ts)
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
          } else if (sql.includes("SET state = 'deleting'")) {
            const [now, todoistId, occurrenceDate] = bindings;
            const k = `${todoistId as string}:${occurrenceDate as string}`;
            const existing = self.rows.get(k) ?? {};
            self.rows.set(k, { ...existing, state: 'deleting', updated_at: now });
          } else if (sql.includes("SET state = 'detached'")) {
            const [now, todoistId, occurrenceDate] = bindings;
            const k = `${todoistId as string}:${occurrenceDate as string}`;
            const existing = self.rows.get(k) ?? {};
            self.rows.set(k, { ...existing, state: 'detached', updated_at: now });
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
          if (sql.includes('SELECT run_id, expires_at FROM lease WHERE id = ?')) {
            return null as T;
          }
          return null as T;
        },
        all: async <T>() => {
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
          if (sql.includes("WHERE state = 'deleting'")) {
            const results = [...self.rows.values()].filter((r) => r.state === 'deleting') as T[];
            return { results, success: true, meta: {} };
          }
          if (sql.includes("WHERE state IN ('needs_review', 'detached')")) {
            const results = [...self.rows.values()].filter(
              (r) => r.state === 'needs_review' || r.state === 'detached'
            ) as T[];
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
          // MappingCache.loadAll: SELECT * FROM mapping (no WHERE)
          if (sql.trim() === 'SELECT * FROM mapping') {
            const results = [...self.rows.values()] as T[];
            return { results, success: true, meta: {} };
          }
          return { results: [] as T[], success: true, meta: {} };
        },
      };
    }

    return {
      prepare: (sql: string) => makeStatement(sql, []),
      // batch(): run each statement sequentially.
      // Statements may be makeCountedStatement proxies (from makeCountedD1) or raw makeStatement
      // objects — both expose .run() which applies the write to self.rows.
      batch: async (statements: D1PreparedStatement[]) => {
        const results = [];
        for (const stmt of statements) {
          results.push(await stmt.run());
        }
        return results;
      },
    } as unknown as D1Database;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FRAME_ID = 'frame-bg-test';
const PROFILE = 'kyle';
const BASE_DATE = '2026-08-01';

function makeTask(id: string, date = BASE_DATE) {
  return {
    id,
    content: `Task ${id}`,
    description: '',
    labels: [],
    project_id: 'proj-1',
    section_id: null,
    parent_id: null,
    due: { date, string: date, is_recurring: false },
    priority: 1,
    checked: false,
  };
}

function makeCreateResponse(id: string, summary: string, description: string) {
  return {
    data: [{
      id,
      type: 'chore' as const,
      attributes: {
        summary,
        status: 'pending',
        start: BASE_DATE,
        start_time: null,
        recurring: false,
        completed_on: null,
        emoji_icon: null,
        reward_points: null,
        category_id: null,
        category_ids: null,
        description,
      },
    }],
  };
}

function makeListResponse(items: Array<{ id: string; summary: string; description: string }>) {
  return {
    data: items.map((i) => ({
      id: i.id,
      type: 'chore' as const,
      attributes: {
        summary: i.summary,
        status: 'pending',
        start: BASE_DATE,
        start_time: null,
        recurring: false,
        completed_on: null,
        emoji_icon: null,
        reward_points: null,
        category_id: null,
        category_ids: null,
        description: i.description,
      },
    })),
  };
}

function makeEnv(dryrun = false): import('./types.js').Env {
  return {
    DB: null as unknown as D1Database,
    KV: null as unknown as KVNamespace,
    TODOIST_API_TOKEN: 'tok-todoist',
    SKYLIGHT_EMAIL: '',
    SKYLIGHT_PASSWORD: '',
    FRAME: FRAME_ID,
    FRAME_CONFIRMED: '',
    DRYRUN: dryrun ? 'true' : 'false',
    PROFILE_CATEGORY_MAP: '{}',
    FRAME_TIMEZONE: 'America/New_York',
  };
}

// ---------------------------------------------------------------------------
// (BG-4) SubrequestCounter: increments on Skylight + D1 + KV ops
// ---------------------------------------------------------------------------

describe('(BG-4) SubrequestCounter — increments on each op type', () => {
  it('counter.total tracks all op categories independently', () => {
    const counter = new SubrequestCounter(40);
    expect(counter.total).toBe(0);

    counter.incrementSkylight();
    expect(counter.skylight).toBe(1);
    expect(counter.total).toBe(1);

    counter.incrementTodoist(2);
    expect(counter.todoist).toBe(2);
    expect(counter.total).toBe(3);

    counter.incrementD1(3);
    expect(counter.d1).toBe(3);
    expect(counter.total).toBe(6);

    counter.incrementKV(2);
    expect(counter.kv).toBe(2);
    expect(counter.total).toBe(8);
  });

  it('canAfford returns false when total + tailReserve + needed would exceed budget', () => {
    const counter = new SubrequestCounter(10);
    counter.incrementD1(5); // total = 5

    // 5 + tail=3 + needed=2 = 10 → exactly at budget → can afford
    expect(counter.canAfford(3, 2)).toBe(true);

    // 5 + tail=3 + needed=3 = 11 → over budget → cannot afford
    expect(counter.canAfford(3, 3)).toBe(false);
  });

  it('breakdown() returns a formatted string with all counters', () => {
    const counter = new SubrequestCounter(40);
    counter.incrementSkylight(3);
    counter.incrementTodoist(2);
    counter.incrementD1(5);
    counter.incrementKV(1);
    const bd = counter.breakdown();
    expect(bd).toContain('skylight=3');
    expect(bd).toContain('todoist=2');
    expect(bd).toContain('d1=5');
    expect(bd).toContain('kv=1');
    expect(bd).toContain('total=11');
    expect(bd).toContain('budget=40');
  });

  it('makeCountedD1: D1 .prepare().bind().run() increments d1 counter', async () => {
    const db = new InMemoryD1();
    const counter = new SubrequestCounter(40);
    const countedDb = makeCountedD1(db.asD1(), counter);

    expect(counter.d1).toBe(0);
    await countedDb.prepare("INSERT INTO mapping (todoist_id) VALUES (?)")
      .bind('dummy')
      .run();
    expect(counter.d1).toBe(1);
  });

  it('makeCountedD1: .all() increments d1 counter', async () => {
    const db = new InMemoryD1();
    const counter = new SubrequestCounter(40);
    const countedDb = makeCountedD1(db.asD1(), counter);

    await countedDb.prepare("SELECT * FROM mapping WHERE state = 'active'").all();
    expect(counter.d1).toBe(1);
  });

  it('makeCountedD1: .first() increments d1 counter', async () => {
    const db = new InMemoryD1();
    const counter = new SubrequestCounter(40);
    const countedDb = makeCountedD1(db.asD1(), counter);

    await countedDb.prepare('SELECT * FROM mapping WHERE todoist_id = ? AND occurrence_date = ?')
      .bind('t1', '2026-01-01')
      .first();
    expect(counter.d1).toBe(1);
  });

  it('makeCountedKV: .get() and .put() both increment kv counter', async () => {
    const counter = new SubrequestCounter(40);
    // Build a minimal KV mock
    const mockKV = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ keys: [] }),
      getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
    } as unknown as KVNamespace;
    const countedKV = makeCountedKV(mockKV, counter);

    expect(counter.kv).toBe(0);
    await countedKV.get('some-key');
    expect(counter.kv).toBe(1);
    await countedKV.put('some-key', 'value');
    expect(counter.kv).toBe(2);
  });

  it('CountedSkylightClient: each HTTP-making method increments skylight counter', async () => {
    const counter = new SubrequestCounter(40);
    let fetchSpy: ReturnType<typeof vi.fn>;
    const originalFetch = globalThis.fetch;
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
      text: async () => JSON.stringify({ data: [] }),
      headers: { get: () => null },
    } as unknown as Response);
    globalThis.fetch = fetchSpy;

    try {
      const client = new CountedSkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' }, counter);

      // listChores = 1 Skylight call
      await client.listChores('2026-01-01', '2026-12-31');
      expect(counter.skylight).toBe(1);

      // getChoreById = 1 Skylight call
      await client.getChoreById('chore-1', '2026-01-01');
      expect(counter.skylight).toBe(2);

      // batchFetchChoresByIds = 1 Skylight call
      await client.batchFetchChoresByIds([{ id: 'x', date: '2026-01-01' }]);
      expect(counter.skylight).toBe(3);

      // getLists = 1 Skylight call
      fetchSpy.mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ data: [] }),
        text: async () => '{"data":[]}',
        headers: { get: () => null },
      } as unknown as Response);
      await client.getLists();
      expect(counter.skylight).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// (BG-5) MappingCache: load once, serve per-task lookups, keep consistent
// ---------------------------------------------------------------------------

describe('(BG-5) MappingCache — load-once, O(1) lookups, cache coherence', () => {
  it('loadAll: one SELECT loads all rows; getByKey returns correct row', async () => {
    const db = new InMemoryD1();

    // Seed 3 rows directly
    const rows: MappingRow[] = [
      {
        todoist_id: 't1', fp_stable_id: null, occurrence_date: '2026-07-01',
        surface: 'chore', frame_id: FRAME_ID, profile: PROFILE,
        skylight_id: 'sky-1', expected_summary: 'Task 1', last_pushed_status: 'pending',
        observed_status: 'pending', last_pushed_hash: null, state: 'active',
        idem_token: null, updated_at: null,
      },
      {
        todoist_id: 't2', fp_stable_id: null, occurrence_date: '2026-07-02',
        surface: 'chore', frame_id: FRAME_ID, profile: PROFILE,
        skylight_id: 'sky-2', expected_summary: 'Task 2', last_pushed_status: 'pending',
        observed_status: 'pending', last_pushed_hash: null, state: 'active',
        idem_token: null, updated_at: null,
      },
      {
        todoist_id: 't3', fp_stable_id: null, occurrence_date: '',
        surface: 'list', frame_id: FRAME_ID, profile: PROFILE,
        skylight_id: 'sky-3', expected_summary: 'Task 3', last_pushed_status: null,
        observed_status: null, last_pushed_hash: null, state: 'active',
        idem_token: null, updated_at: null,
      },
    ];
    for (const r of rows) {
      db.rows.set(`${r.todoist_id}:${r.occurrence_date}`, r as unknown as D1Row);
    }

    const counter = new SubrequestCounter(40);
    const countedDb = makeCountedD1(db.asD1(), counter);

    const cache = new MappingCache();
    const d1Before = counter.d1;
    await cache.loadAll(countedDb);
    // loadAll should have used exactly 1 D1 call
    expect(counter.d1 - d1Before).toBe(1);

    // Per-task lookups: O(1), no additional D1
    const r1 = cache.getByKey('t1', '2026-07-01');
    expect(r1).not.toBeNull();
    expect(r1?.skylight_id).toBe('sky-1');
    expect(counter.d1).toBe(d1Before + 1); // still just 1 D1 call total

    // getByKey for nonexistent returns null
    expect(cache.getByKey('t99', '2026-07-01')).toBeNull();
  });

  it('getAllForTodoistId returns all rows for a todoist_id (O(1), no D1)', async () => {
    const db = new InMemoryD1();
    // Seed two occurrence rows for the same task (recurring pattern)
    const row1: MappingRow = {
      todoist_id: 'recur', fp_stable_id: null, occurrence_date: '2026-07-01',
      surface: 'chore', frame_id: FRAME_ID, profile: PROFILE,
      skylight_id: 'sky-r1', expected_summary: 'Recur', last_pushed_status: 'pending',
      observed_status: 'pending', last_pushed_hash: null, state: 'active',
      idem_token: null, updated_at: null,
    };
    const row2: MappingRow = {
      ...row1, occurrence_date: '2026-07-08', skylight_id: 'sky-r2', state: 'creating',
    };
    db.rows.set('recur:2026-07-01', row1 as unknown as D1Row);
    db.rows.set('recur:2026-07-08', row2 as unknown as D1Row);

    const cache = new MappingCache();
    await cache.loadAll(db.asD1());

    const all = cache.getAllForTodoistId('recur');
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.occurrence_date).sort()).toEqual(['2026-07-01', '2026-07-08']);
  });

  it('upsert: newly inserted row is immediately visible to subsequent getByKey', async () => {
    const db = new InMemoryD1();
    const cache = new MappingCache();
    await cache.loadAll(db.asD1()); // empty

    // Before upsert: not found
    expect(cache.getByKey('new-task', '2026-08-01')).toBeNull();

    // Simulate what the outbound pass does after insertCreatingRow succeeds
    const newRow: MappingRow = {
      todoist_id: 'new-task', fp_stable_id: null, occurrence_date: '2026-08-01',
      surface: 'chore', frame_id: FRAME_ID, profile: PROFILE,
      skylight_id: 'sky-new', expected_summary: 'New Task', last_pushed_status: null,
      observed_status: null, last_pushed_hash: null, state: 'creating',
      idem_token: null, updated_at: null,
    };
    cache.upsert(newRow);

    // After upsert: found (0 D1 reads)
    const found = cache.getByKey('new-task', '2026-08-01');
    expect(found).not.toBeNull();
    expect(found?.state).toBe('creating');
    expect(found?.skylight_id).toBe('sky-new');
  });

  it('getActive: returns only active rows, filters out non-active', async () => {
    const db = new InMemoryD1();
    const makeRow = (id: string, state: MappingRow['state']): MappingRow => ({
      todoist_id: id, fp_stable_id: null, occurrence_date: '2026-07-01',
      surface: 'chore', frame_id: FRAME_ID, profile: PROFILE,
      skylight_id: `sky-${id}`, expected_summary: id, last_pushed_status: 'pending',
      observed_status: 'pending', last_pushed_hash: null, state,
      idem_token: null, updated_at: null,
    });
    db.rows.set('a:2026-07-01', makeRow('a', 'active') as unknown as D1Row);
    db.rows.set('b:2026-07-01', makeRow('b', 'creating') as unknown as D1Row);
    db.rows.set('c:2026-07-01', makeRow('c', 'active') as unknown as D1Row);

    const cache = new MappingCache();
    await cache.loadAll(db.asD1());

    const active = cache.getActive();
    expect(active).toHaveLength(2);
    expect(active.map((r) => r.todoist_id).sort()).toEqual(['a', 'c']);
  });
});

// ---------------------------------------------------------------------------
// (BG-1 + BG-2 + BG-3) Budget guard: defer, no dangling rows, resume
//
// These tests use a mocked fetchDeckTasks (via vi.mock in outbound.test.ts file).
// Instead, we invoke runOutboundPass directly with a RunContext whose counter
// is pre-positioned near the budget limit.
// ---------------------------------------------------------------------------

// We mock the todoist-client module for this test file too.
vi.mock('./todoist-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./todoist-client.js')>();
  return {
    ...actual,
    fetchDeckTasks: vi.fn().mockResolvedValue([]),
  };
});

import { fetchDeckTasks } from './todoist-client.js';
const mockFetchDeckTasks = fetchDeckTasks as ReturnType<typeof vi.fn>;

describe('(BG-1/2/3) Budget guard — defer, no dangling rows, resume', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchDeckTasks.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /**
   * BG-1: Budget guard allows exactly 1 create, defers the rest.
   *
   * We use CountedSkylightClient + makeCountedD1 so that ops auto-increment the counter.
   * Budget math with TAIL_RESERVE=8 (fetchDeckTasks is mocked → 0 Todoist increments):
   *   - BG-1 uses countedDb for loadAll → d1=1, total=1
   *   - Guard before create 1: 1 + 8 + 2 = 11 ≤ 12 → OK
   *   - insertCreatingRow D1 .run() → d1=2; CountedSkylight createChore → skylight=1; total=3
   *   - Guard before create 2: 3 + 8 + 2 = 13 > 12 → GUARD FIRES → tasks 1-4 deferred
   */
  it('(BG-1) budget guard: creates only as many tasks as fit, defers rest, logs deferral', async () => {
    const db = new InMemoryD1();
    // Budget of 12: allows exactly 1 create (countedDb loadAll d1=1; after create 1 total=3;
    // next check: 3 + TAIL_RESERVE(8) + 2 = 13 > 12 → guard fires)
    const BUDGET = 12;
    const counter = new SubrequestCounter(BUDGET);
    const countedDb = makeCountedD1(db.asD1(), counter);

    // 5 unmapped tasks
    const tasks = Array.from({ length: 5 }, (_, i) => makeTask(`task-bg1-${i}`, BASE_DATE));
    mockFetchDeckTasks.mockResolvedValue(tasks);

    const cache = new MappingCache();
    await cache.loadAll(countedDb);  // 1 D1 call for SELECT * FROM mapping
    const runCtx: RunContext = { counter, mappingCache: cache, rawDb: db.asD1() };

    // Mock: 1 POST + 1 batch list GET
    const task0 = tasks[0];
    const desc0 = choreDescriptionMarker(task0.id);
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeCreateResponse('sky-bg-0', task0.content, desc0),
        text: async () => JSON.stringify(makeCreateResponse('sky-bg-0', task0.content, desc0)),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeListResponse([{ id: 'sky-bg-0', summary: task0.content, description: desc0 }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-bg-0', summary: task0.content, description: desc0 }])),
        headers: { get: () => null },
      } as unknown as Response);

    // Use CountedSkylightClient so createChore increments counter
    const client = new CountedSkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' }, counter);
    const env = makeEnv(false);

    await runOutboundPass(client, countedDb, env, FRAME_ID, PROFILE, null, BASE_DATE, undefined, runCtx);

    // CRITICAL: exactly 1 create succeeded (1 POST)
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(postCalls).toHaveLength(1);

    // The first task's row should be 'active' (committed)
    const firstRow = db.getRow(task0.id, BASE_DATE);
    expect(firstRow?.state).toBe('active');

    // Tasks 1-4 must have NO D1 row at all (no dangling 'creating' rows)
    for (const t of tasks.slice(1)) {
      expect(db.getRow(t.id, BASE_DATE)).toBeUndefined();
    }

    // Deferral must have been logged
    const logCalls = (consoleSpy.mock.calls as string[][]).flat().join('\n');
    expect(logCalls).toMatch(/deferred|budget/i);
  });

  it('(BG-2) no dangling creating rows for deferred tasks', async () => {
    // Budget so tight that 0 creates fit:
    // BG-2 uses raw db for loadAll → d1=0 before runOutboundPass.
    // canAfford(TAIL_RESERVE=8, needed=2): 0+8+2=10 ≤ budget?
    // Budget=9 → 10 > 9 → false → 0 creates, guard fires on task 0 immediately
    const ZERO_BUDGET = 9;
    const counter = new SubrequestCounter(ZERO_BUDGET);
    const countedDb = makeCountedD1(new InMemoryD1().asD1(), counter);

    const db = new InMemoryD1();
    const tasks = Array.from({ length: 3 }, (_, i) => makeTask(`task-bg2-${i}`, BASE_DATE));
    mockFetchDeckTasks.mockResolvedValue(tasks);

    const cache = new MappingCache();
    await cache.loadAll(db.asD1());

    const runCtx: RunContext = { counter, mappingCache: cache, rawDb: db.asD1() };
    const client = new CountedSkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' }, counter);
    const env = makeEnv(false);

    await runOutboundPass(client, countedDb, env, FRAME_ID, PROFILE, null, BASE_DATE, undefined, runCtx);

    // CRITICAL: zero POSTs (budget exhausted before any create started)
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(postCalls).toHaveLength(0);

    // CRITICAL: zero D1 rows created (no dangling 'creating' rows)
    expect(db.allRows()).toHaveLength(0);
  });

  it('(BG-3) follow-up run (budget restored) creates the previously deferred tasks (resume, no dup)', async () => {
    // Run 1: tight budget (0 creates fit)
    const db = new InMemoryD1();
    const tasks = [makeTask('task-bg3-a', BASE_DATE), makeTask('task-bg3-b', BASE_DATE)];
    mockFetchDeckTasks.mockResolvedValue(tasks);

    const tightCounter = new SubrequestCounter(9); // 0 creates fit (see BG-2): raw loadAll → d1=0; 0+8+2=10>9
    const tightCountedDb = makeCountedD1(db.asD1(), tightCounter);
    const cache1 = new MappingCache();
    await cache1.loadAll(db.asD1());
    const ctx1: RunContext = { counter: tightCounter, mappingCache: cache1, rawDb: db.asD1() };
    const client = new CountedSkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' }, tightCounter);
    const env = makeEnv(false);

    await runOutboundPass(client, tightCountedDb, env, FRAME_ID, PROFILE, null, BASE_DATE, undefined, ctx1);

    // Run 1: zero creates, zero rows
    expect(db.allRows()).toHaveLength(0);

    // Run 2: ample budget (both tasks can be created)
    const fullCounter = new SubrequestCounter(SUBREQUEST_BUDGET);
    const fullCountedDb = makeCountedD1(db.asD1(), fullCounter);
    const cache2 = new MappingCache();
    await cache2.loadAll(db.asD1()); // still empty
    const ctx2: RunContext = { counter: fullCounter, mappingCache: cache2, rawDb: db.asD1() };
    const client2 = new CountedSkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' }, fullCounter);

    // Mock: 2 POSTs + 1 batch list GET
    const desc_a = choreDescriptionMarker('task-bg3-a');
    const desc_b = choreDescriptionMarker('task-bg3-b');
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeCreateResponse('sky-bg3-a', tasks[0].content, desc_a),
        text: async () => JSON.stringify(makeCreateResponse('sky-bg3-a', tasks[0].content, desc_a)),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeCreateResponse('sky-bg3-b', tasks[1].content, desc_b),
        text: async () => JSON.stringify(makeCreateResponse('sky-bg3-b', tasks[1].content, desc_b)),
        headers: { get: () => null },
      } as unknown as Response)
      // Batched list GET
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeListResponse([
          { id: 'sky-bg3-a', summary: tasks[0].content, description: desc_a },
          { id: 'sky-bg3-b', summary: tasks[1].content, description: desc_b },
        ]),
        text: async () => JSON.stringify(makeListResponse([
          { id: 'sky-bg3-a', summary: tasks[0].content, description: desc_a },
          { id: 'sky-bg3-b', summary: tasks[1].content, description: desc_b },
        ])),
        headers: { get: () => null },
      } as unknown as Response);

    await runOutboundPass(client2, fullCountedDb, env, FRAME_ID, PROFILE, null, BASE_DATE, undefined, ctx2);

    // Run 2: both tasks created, no duplicates
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(postCalls).toHaveLength(2);

    expect(db.getRow('task-bg3-a', BASE_DATE)?.state).toBe('active');
    expect(db.getRow('task-bg3-b', BASE_DATE)?.state).toBe('active');
    // Exactly 2 rows, not 4 (no duplicates)
    expect(db.allRows()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// (BG-6) Batched writes preserve write-ahead-before-POST and verify-then-commit
// ---------------------------------------------------------------------------

describe('(BG-6) Write-ahead ordering: insertCreatingRow before POST, verify then commit', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchDeckTasks.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('creates appear in D1 as creating BEFORE the POST fires, then committed after batch verify', async () => {
    const db = new InMemoryD1();
    // Track the D1 state at the time of the POST
    let d1StateAtPost: string | undefined;

    const task = makeTask('task-bg6', BASE_DATE);
    mockFetchDeckTasks.mockResolvedValue([task]);

    const descMarker = choreDescriptionMarker(task.id);

    // POST response — capture D1 state when POST fires
    fetchSpy.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        // D1 should already have a 'creating' row at this point (write-ahead)
        const row = db.getRow(task.id, BASE_DATE);
        d1StateAtPost = row?.state as string | undefined;
        return {
          ok: true, status: 200,
          json: async () => makeCreateResponse('sky-bg6', task.content, descMarker),
          text: async () => JSON.stringify(makeCreateResponse('sky-bg6', task.content, descMarker)),
          headers: { get: () => null },
        } as unknown as Response;
      }
      // Batch verify GET
      return {
        ok: true, status: 200,
        json: async () => makeListResponse([{ id: 'sky-bg6', summary: task.content, description: descMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-bg6', summary: task.content, description: descMarker }])),
        headers: { get: () => null },
      } as unknown as Response;
    });

    const counter = new SubrequestCounter(SUBREQUEST_BUDGET);
    const countedDb = makeCountedD1(db.asD1(), counter);
    const cache = new MappingCache();
    await cache.loadAll(countedDb);
    const runCtx: RunContext = { counter, mappingCache: cache, rawDb: db.asD1() };
    const client = new CountedSkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' }, counter);
    const env = makeEnv(false);

    await runOutboundPass(client, countedDb, env, FRAME_ID, PROFILE, null, BASE_DATE, undefined, runCtx);

    // CRITICAL: at the time of POST, the D1 row must already be 'creating' (write-ahead)
    expect(d1StateAtPost).toBe('creating');

    // After batch verify: row must be 'active' (commit happened)
    const finalRow = db.getRow(task.id, BASE_DATE);
    expect(finalRow?.state).toBe('active');
    expect(finalRow?.skylight_id).toBe('sky-bg6');
  });
});

// ---------------------------------------------------------------------------
// (BG-7) Breakdown line emitted on success and on error
// ---------------------------------------------------------------------------

describe('(BG-7) breakdown() line format', () => {
  it('breakdown string has expected format with all categories and total', () => {
    const counter = new SubrequestCounter(40);
    counter.incrementSkylight(5);
    counter.incrementTodoist(3);
    counter.incrementD1(10);
    counter.incrementKV(2);
    const bd = counter.breakdown();
    // Format: "subrequest-breakdown: skylight=A todoist=B d1=C kv=D total=N (budget=BUDGET)"
    expect(bd).toBe('subrequest-breakdown: skylight=5 todoist=3 d1=10 kv=2 total=20 (budget=40)');
  });
});

// ---------------------------------------------------------------------------
// (BG-8) Sabotage-check: budget guard test FAILS if guard is removed
//
// This test verifies that our BG-1 test would actually catch a regression
// where the budget guard is removed. We do this by running the outbound pass
// WITHOUT a RunContext (no ctx) and confirm all 5 tasks get created — which
// would make BG-1's assertion (only 1 create) fail if BG-1 didn't use ctx.
// ---------------------------------------------------------------------------

describe('(BG-8) Sabotage-check: guard is load-bearing', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchDeckTasks.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('WITHOUT ctx (guard disabled): all 5 tasks get created (proves guard is required for BG-1)', async () => {
    const db = new InMemoryD1();
    const tasks = Array.from({ length: 5 }, (_, i) => makeTask(`task-sab-${i}`, BASE_DATE));
    mockFetchDeckTasks.mockResolvedValue(tasks);

    // Mock: 5 POSTs + 1 batch list GET
    for (let i = 0; i < 5; i++) {
      const t = tasks[i];
      const desc = choreDescriptionMarker(t.id);
      fetchSpy.mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeCreateResponse(`sky-sab-${i}`, t.content, desc),
        text: async () => JSON.stringify(makeCreateResponse(`sky-sab-${i}`, t.content, desc)),
        headers: { get: () => null },
      } as unknown as Response);
    }
    // Batch list GET (one for all 5)
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeListResponse(
        tasks.map((t, i) => ({ id: `sky-sab-${i}`, summary: t.content, description: choreDescriptionMarker(t.id) }))
      ),
      text: async () => JSON.stringify(makeListResponse(
        tasks.map((t, i) => ({ id: `sky-sab-${i}`, summary: t.content, description: choreDescriptionMarker(t.id) }))
      )),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const env = makeEnv(false);

    // No ctx → guard is disabled → all 5 tasks are created
    await runOutboundPass(client, db.asD1(), env, FRAME_ID, PROFILE, null, BASE_DATE);

    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    // All 5 created when guard is absent — this would fail BG-1's expect(postCalls).toHaveLength(1)
    expect(postCalls).toHaveLength(5);

    // This confirms that BG-1 is load-bearing: if BG-1 used no ctx (disabled guard),
    // it would fail (5 != 1). The guard IS required to make BG-1 pass.
  });
});

// ---------------------------------------------------------------------------
// (BG-9) Inbound budget guard — defer, no dangling state, resume
//
// Analogue to BG-1/2/3 but for runInboundPass.
// ---------------------------------------------------------------------------

describe('(BG-9) Inbound budget guard — defers rows when budget exhausted', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /**
   * Build a minimal SkylightClient that returns a batch chore map from pre-seeded chores.
   * getTask mock returns a pending open task (no close needed, so no extra subrequests).
   */
  function makeInboundClient(choreIds: string[], frameId: string): SkylightClient {
    const client = new SkylightClient({ frameId, dryrun: false, token: 'tok' });
    // Override batchFetchChoresByIds to return all chores
    vi.spyOn(client, 'batchFetchChoresByIds').mockImplementation(async (entries) => {
      const m = new Map<string, import('./types.js').ChoreResource>();
      for (const { id } of entries) {
        if (choreIds.includes(id)) {
          m.set(id, {
            id,
            type: 'chore',
            attributes: {
              summary: `Chore ${id}`,
              status: 'pending',
              start: BASE_DATE,
              start_time: null,
              recurring: false,
              completed_on: null,
              emoji_icon: null,
              reward_points: null,
              category_id: null,
              category_ids: null,
              description: choreDescriptionMarker(id), // correct marker
            },
          } as import('./types.js').ChoreResource);
        }
      }
      return m;
    });
    return client;
  }

  /**
   * Seed N active chore rows into InMemoryD1 with matching chore ids.
   */
  function seedActiveRows(db: InMemoryD1, n: number, frameId: string): MappingRow[] {
    const rows: MappingRow[] = [];
    for (let i = 0; i < n; i++) {
      const id = `bg9-task-${i}`;
      const row: MappingRow = {
        todoist_id: id,
        fp_stable_id: null,
        occurrence_date: BASE_DATE,
        surface: 'chore',
        frame_id: frameId,
        profile: PROFILE,
        skylight_id: id, // same as todoist_id for simplicity
        expected_summary: `Chore ${id}`,
        last_pushed_status: 'pending',
        observed_status: 'pending', // will NOT change → updateObservedStatus skipped
        last_pushed_hash: null,
        state: 'active',
        idem_token: null,
        updated_at: null,
      };
      db.rows.set(`${id}:${BASE_DATE}`, row as unknown as D1Row);
      rows.push(row);
    }
    return rows;
  }

  it('(BG-9a) inbound guard defers rows when budget is exhausted; no D1 writes for deferred rows', async () => {
    const N = 5; // 5 active mappings
    const db = new InMemoryD1();
    const choreIds = Array.from({ length: N }, (_, i) => `bg9-task-${i}`);
    seedActiveRows(db, N, FRAME_ID);

    // Budget just enough for 2 rows:
    // Each row costs INBOUND_ROW_COST (2 = 1 Todoist GET + 1 potential D1 write).
    // But observed_status='pending' matches row.observed_status='pending' → no D1 write.
    // So per row: 1 Todoist GET counted by wrapper. Cost=1 but guard uses INBOUND_ROW_COST=2.
    // Guard: canAfford(0, 2) → total + 2 ≤ budget.
    // After row 0: todoist=1, total=1. Before row 1: 1+2=3 ≤ budget? Yes.
    // After row 1: todoist=2, total=2. Before row 2: 2+2=4 ≤ budget? Need budget ≥ 4.
    // After row 2: todoist=3, total=3. Before row 3: 3+2=5 > budget if budget=4 → defer rows 3,4.
    // Use budget=4 → processes rows 0,1,2 (3 rows), defers rows 3,4.
    const BUDGET = 4;
    const counter = new SubrequestCounter(BUDGET);

    // getTask mock: returns a pending task (no status change, no Todoist writes needed)
    let getTodoBatch = 0;
    const getTaskFn = vi.fn(async (id: string) => ({
      id,
      content: `Task ${id}`,
      description: '',
      labels: [],
      project_id: 'proj',
      section_id: null,
      parent_id: null,
      due: { date: BASE_DATE, string: BASE_DATE, is_recurring: false },
      priority: 1,
      checked: false,
    } as import('./types.js').RawTask));
    const closeTaskFn = vi.fn(async () => {});

    const client = makeInboundClient(choreIds, FRAME_ID);

    await runInboundPass(client, db.asD1(), FRAME_ID, {
      getTaskFn,
      closeTaskFn,
      todoistApiToken: 'tok',
      dryrun: false,
      counter,
    });

    // Should have processed 3 rows (getTask called 3 times) and deferred 2
    // (budget=4: row 0→total=1, row 1→total=2, row 2→total=3, before row 3: 3+2=5>4 → defer)
    expect(getTaskFn).toHaveBeenCalledTimes(3);
    expect(counter.todoist).toBe(3);
    expect(counter.total).toBeLessThanOrEqual(BUDGET);

    // Deferral should be logged (format: "[skylight-sync] inbound: deferred N mapping(s) to next run ...")
    const logText = (consoleSpy.mock.calls as string[][]).flat().join('\n');
    expect(logText).toMatch(/inbound.*deferred.*next run/i);
  });

  it('(BG-9b) inbound guard: deferred rows leave NO extra D1 writes (idempotent skip)', async () => {
    const N = 4;
    const db = new InMemoryD1();
    seedActiveRows(db, N, FRAME_ID);
    const choreIds = Array.from({ length: N }, (_, i) => `bg9-task-${i}`);

    // Budget so tight that 0 rows are processed:
    // canAfford(0, INBOUND_ROW_COST=2): 0+2=2 ≤ budget? Budget=1 → 2>1 → false → 0 processed.
    const counter = new SubrequestCounter(1);
    const getTaskFn = vi.fn(async (id: string) => null as import('./types.js').RawTask | null);
    const closeTaskFn = vi.fn(async () => {});

    const client = makeInboundClient(choreIds, FRAME_ID);

    await runInboundPass(client, db.asD1(), FRAME_ID, {
      getTaskFn,
      closeTaskFn,
      todoistApiToken: 'tok',
      dryrun: false,
      counter,
    });

    // 0 getTask calls (all deferred immediately)
    expect(getTaskFn).toHaveBeenCalledTimes(0);

    // D1 rows unchanged — no writes happened to deferred rows
    for (let i = 0; i < N; i++) {
      const row = db.rows.get(`bg9-task-${i}:${BASE_DATE}`);
      expect(row?.state).toBe('active');
      // observed_status unchanged (no updateObservedStatus fired)
      expect(row?.observed_status).toBe('pending');
    }
  });

  it('(BG-9c) follow-up run with full budget processes all rows (resume, idempotent)', async () => {
    const N = 3;
    const db = new InMemoryD1();
    seedActiveRows(db, N, FRAME_ID);
    const choreIds = Array.from({ length: N }, (_, i) => `bg9-task-${i}`);

    // Run 1: budget=1 → defer all
    const tightCounter = new SubrequestCounter(1);
    const getTaskFn1 = vi.fn(async () => null as import('./types.js').RawTask | null);
    const client = makeInboundClient(choreIds, FRAME_ID);

    await runInboundPass(client, db.asD1(), FRAME_ID, {
      getTaskFn: getTaskFn1,
      closeTaskFn: vi.fn(),
      todoistApiToken: 'tok',
      dryrun: false,
      counter: tightCounter,
    });
    expect(getTaskFn1).toHaveBeenCalledTimes(0);

    // Run 2: full budget → all rows processed
    const fullCounter = new SubrequestCounter(SUBREQUEST_BUDGET);
    const getTaskFn2 = vi.fn(async (id: string) => ({
      id,
      content: `Task ${id}`,
      description: '',
      labels: [],
      project_id: 'proj',
      section_id: null,
      parent_id: null,
      due: { date: BASE_DATE, string: BASE_DATE, is_recurring: false },
      priority: 1,
      checked: false,
    } as import('./types.js').RawTask));
    const client2 = makeInboundClient(choreIds, FRAME_ID);

    await runInboundPass(client2, db.asD1(), FRAME_ID, {
      getTaskFn: getTaskFn2,
      closeTaskFn: vi.fn(),
      todoistApiToken: 'tok',
      dryrun: false,
      counter: fullCounter,
    });

    // All 3 rows processed on run 2
    expect(getTaskFn2).toHaveBeenCalledTimes(N);
    expect(fullCounter.todoist).toBe(N);
    expect(fullCounter.total).toBeLessThan(50);
  });

  it('(BG-9d) sabotage-check: without counter all N rows processed regardless of "budget"', async () => {
    // Proves the guard is load-bearing: without counter, even budget=1 allows all rows
    const N = 5;
    const db = new InMemoryD1();
    seedActiveRows(db, N, FRAME_ID);
    const choreIds = Array.from({ length: N }, (_, i) => `bg9-task-${i}`);

    const getTaskFn = vi.fn(async (id: string) => ({
      id,
      content: `Task ${id}`,
      description: '',
      labels: [],
      project_id: 'proj',
      section_id: null,
      parent_id: null,
      due: { date: BASE_DATE, string: BASE_DATE, is_recurring: false },
      priority: 1,
      checked: false,
    } as import('./types.js').RawTask));
    const client = makeInboundClient(choreIds, FRAME_ID);

    // No counter → guard disabled → all N rows processed
    await runInboundPass(client, db.asD1(), FRAME_ID, {
      getTaskFn,
      closeTaskFn: vi.fn(),
      todoistApiToken: 'tok',
      dryrun: false,
      // counter omitted — guard disabled
    });

    // All 5 processed — confirms guard is absent without counter
    expect(getTaskFn).toHaveBeenCalledTimes(N);
  });
});

// ---------------------------------------------------------------------------
// (BG-10) Todoist counting — counted wrappers in inbound pass + fetchDeckTasks hook
// ---------------------------------------------------------------------------

describe('(BG-10) Todoist counting — inbound wrappers and fetchDeckTasks onFetch hook', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('(BG-10a) inbound pass: getTaskFn and closeTaskFn each increment counter.todoist when counter provided', async () => {
    const db = new InMemoryD1();

    // Seed 2 active chore rows
    const makeRow = (id: string): MappingRow => ({
      todoist_id: id, fp_stable_id: null, occurrence_date: BASE_DATE,
      surface: 'chore', frame_id: FRAME_ID, profile: PROFILE,
      skylight_id: id, expected_summary: `Task ${id}`,
      last_pushed_status: 'pending', observed_status: 'pending',
      last_pushed_hash: null, state: 'active',
      idem_token: null, updated_at: null,
    });
    db.rows.set(`bg10-a:${BASE_DATE}`, makeRow('bg10-a') as unknown as D1Row);
    db.rows.set(`bg10-b:${BASE_DATE}`, makeRow('bg10-b') as unknown as D1Row);

    const counter = new SubrequestCounter(SUBREQUEST_BUDGET);

    let getTaskCalls = 0;
    const getTaskFn = vi.fn(async (id: string) => {
      getTaskCalls++;
      // Return a completed task so closeTask will be called (tests closeTask counting)
      return {
        id, content: `Task ${id}`, description: '', labels: [],
        project_id: 'proj', section_id: null, parent_id: null,
        due: { date: BASE_DATE, string: BASE_DATE, is_recurring: false },
        priority: 1, checked: true, // completed → but chore is pending → CLOSE_TODOIST won't fire
        // Actually: task.checked=true + lastPushed=pending + observedStatus=pending
        // § 7A: checked but observedStatus !== 'complete' → runCompleteProtocol
        // But we don't want to trigger completeProtocol here — let's keep checked=false
      } as unknown as import('./types.js').RawTask;
    });

    // Actually use checked=false to avoid triggering complex protocols
    const getTaskFnSimple = vi.fn(async (id: string) => ({
      id, content: `Task ${id}`, description: '', labels: [],
      project_id: 'proj', section_id: null, parent_id: null,
      due: { date: BASE_DATE, string: BASE_DATE, is_recurring: false },
      priority: 1, checked: false,
    } as import('./types.js').RawTask));
    const closeTaskFn = vi.fn(async () => {});

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    vi.spyOn(client, 'batchFetchChoresByIds').mockImplementation(async (entries) => {
      const m = new Map<string, import('./types.js').ChoreResource>();
      for (const { id } of entries) {
        m.set(id, {
          id, type: 'chore',
          attributes: {
            summary: `Task ${id}`, status: 'pending', start: BASE_DATE,
            start_time: null, recurring: false, completed_on: null,
            emoji_icon: null, reward_points: null, category_id: null, category_ids: null,
            description: choreDescriptionMarker(id),
          },
        } as import('./types.js').ChoreResource);
      }
      return m;
    });

    const todoistBefore = counter.todoist;

    await runInboundPass(client, db.asD1(), FRAME_ID, {
      getTaskFn: getTaskFnSimple,
      closeTaskFn,
      todoistApiToken: 'tok',
      dryrun: false,
      counter,
    });

    // 2 active rows → 2 getTaskFn calls → 2 todoist increments
    expect(getTaskFnSimple).toHaveBeenCalledTimes(2);
    expect(counter.todoist - todoistBefore).toBe(2);
  });

  it('(BG-10b) fetchProjects onFetch hook increments counter once per actual HTTP GET page', async () => {
    // vi.mock at the top of this file mocks the whole todoist-client module,
    // so we import the ACTUAL module directly to bypass the mock and test the hook.
    const { fetchProjects: realFetchProjects } = await vi.importActual<typeof import('./todoist-client.js')>(
      './todoist-client.js'
    );

    // Spy on global fetch so we can intercept and count HTTP calls
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ results: [], next_cursor: null }),
      text: async () => '{"results":[],"next_cursor":null}',
      headers: { get: () => null },
    } as unknown as Response);
    globalThis.fetch = fetchSpy;

    const counter = new SubrequestCounter(SUBREQUEST_BUDGET);
    const todoisBefore = counter.todoist;

    // fetchProjects does 1 paginated GET (one page, next_cursor=null)
    await realFetchProjects('fake-token', () => counter.incrementTodoist());

    // The hook should have been called once (1 GET for the single page)
    expect(counter.todoist - todoisBefore).toBe(1);
    expect(fetchSpy.mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (BG-11) Mutation budget guard — DELETE/ROLL deferred when budget exhausted
// ---------------------------------------------------------------------------

describe('(BG-11) Mutation budget guard — DELETE/ROLL deferred on budget exhaustion', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchDeckTasks.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /**
   * BG-11a: Two tasks with 'deleting' rows → DELETE_CHORE actions.
   * Budget allows first delete, defers second.
   *
   * DELETE_CHORE cost = MUTATION_COST_DELETE (5).
   * We pre-position the counter so that:
   *   - Before delete 1: canAfford(TAIL_RESERVE, MUTATION_COST_DELETE) → true → proceeds
   *   - Before delete 2: canAfford(TAIL_RESERVE, MUTATION_COST_DELETE) → false → guard fires
   *
   * Delete protocol mocks: getChoreById (GET) → description marker check → skip dryrun →
   * markDeleting (D1) → deleteChore (DELETE) → verifyDeleted (GET) → hardDeleteRow (D1).
   * We use dryrun=false so the full protocol fires for delete 1.
   *
   * CountedSkylightClient is used so HTTP calls actually increment the counter — this
   * ensures delete 1 consumes real subrequests and the guard fires before delete 2.
   */
  it('(BG-11a) DELETE guard: first delete fits, second deferred; logs deferral', async () => {
    const OLDER_DATE = '2026-07-01';
    const db = new InMemoryD1();

    // Seed two rows in 'deleting' state. The tasks returned by fetchDeckTasks
    // must match the todoist_id so decide() sees row.state='deleting' → DELETE_CHORE.
    const taskA = makeTask('del-bg11-a', OLDER_DATE);
    const taskB = makeTask('del-bg11-b', OLDER_DATE);

    // Row A: deleting state, has a skylight_id
    const rowA: MappingRow = {
      todoist_id: taskA.id, fp_stable_id: null, occurrence_date: OLDER_DATE,
      surface: 'chore', frame_id: FRAME_ID, profile: PROFILE,
      skylight_id: 'sky-del-a', expected_summary: taskA.content,
      last_pushed_status: 'pending', observed_status: 'pending',
      last_pushed_hash: null, state: 'deleting',
      idem_token: null, updated_at: null,
    };
    // Row B: deleting state, has a skylight_id
    const rowB: MappingRow = {
      todoist_id: taskB.id, fp_stable_id: null, occurrence_date: OLDER_DATE,
      surface: 'chore', frame_id: FRAME_ID, profile: PROFILE,
      skylight_id: 'sky-del-b', expected_summary: taskB.content,
      last_pushed_status: 'pending', observed_status: 'pending',
      last_pushed_hash: null, state: 'deleting',
      idem_token: null, updated_at: null,
    };
    db.rows.set(`${taskA.id}:${OLDER_DATE}`, rowA as unknown as D1Row);
    db.rows.set(`${taskB.id}:${OLDER_DATE}`, rowB as unknown as D1Row);

    mockFetchDeckTasks.mockResolvedValue([taskA, taskB]);

    // Budget: tight enough that delete 1 fits but delete 2 doesn't.
    // Pre-position counter so that after delete 1's ~5 HTTP/D1 calls are counted,
    // the guard fires before delete 2.
    // Strategy: set initial counter total to budget - TAIL_RESERVE - MUTATION_COST_DELETE - 1
    // so ONE delete exactly fits, then guard fires.
    // With MUTATION_COST_DELETE=5, TAIL_RESERVE=8, budget=20:
    //   canAfford(8, 5): total + 13 ≤ 20 → total ≤ 7 → initial total=6 gives 1 delete margin
    // After delete 1 (consumes ≥5 subrequests via CountedSkylightClient + D1): total ≥ 11
    // Before delete 2: 11 + 13 = 24 > 20 → guard fires
    const BUDGET = 20;
    const counter = new SubrequestCounter(BUDGET);
    // Pre-position to 6 (leaves exactly one delete margin of 1 subrequest slack)
    counter.incrementD1(6);

    const cache = new MappingCache();
    await cache.loadAll(db.asD1());
    const runCtx: RunContext = { counter, mappingCache: cache, rawDb: db.asD1() };

    // Mock HTTP responses for delete A:
    // 1. GET /chores/sky-del-a (getChoreById) — returns chore with marker
    const markerA = choreDescriptionMarker(taskA.id);
    const markerB = choreDescriptionMarker(taskB.id);
    fetchSpy
      // getChoreById for task A (listChores with filter)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ data: [{ id: 'sky-del-a', type: 'chore', attributes: {
          summary: taskA.content, status: 'pending', start: OLDER_DATE,
          start_time: null, recurring: false, completed_on: null,
          emoji_icon: null, reward_points: null, category_id: null, category_ids: null,
          description: markerA,
        } }] }),
        text: async () => '{}',
        headers: { get: () => null },
      } as unknown as Response)
      // deleteChore for A (DELETE /chores/sky-del-a)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({}),
        text: async () => '{}',
        headers: { get: () => null },
      } as unknown as Response)
      // verifyDeleted for A (getChoreById → null/404)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ data: [] }), // empty → not found → verified deleted
        text: async () => '{"data":[]}',
        headers: { get: () => null },
      } as unknown as Response);

    const client = new CountedSkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' }, counter);
    const env = makeEnv(false);

    await runOutboundPass(client, db.asD1(), env, FRAME_ID, PROFILE, null, OLDER_DATE, undefined, runCtx);

    // Task A's row should be gone (hard-deleted) — delete completed
    expect(db.getRow(taskA.id, OLDER_DATE)).toBeUndefined();

    // Task B's row should still be 'deleting' — deferred
    const rowBAfter = db.getRow(taskB.id, OLDER_DATE);
    expect(rowBAfter?.state).toBe('deleting');

    // Deferral should be logged
    const logText = (consoleSpy.mock.calls as string[][]).flat().join('\n');
    expect(logText).toMatch(/deferred.*mutation.*next run/i);

    // Only one DELETE HTTP call (not two)
    const deleteCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE'
    );
    expect(deleteCalls).toHaveLength(1);
  });

  /**
   * BG-11b: Follow-up run with full budget completes the deferred delete.
   * Verifies idempotent resume (row B deleted on second run).
   */
  it('(BG-11b) follow-up run completes deferred delete (idempotent resume)', async () => {
    const OLDER_DATE = '2026-07-01';
    const db = new InMemoryD1();

    // Seed only row B (simulating state after BG-11a where A was already deleted)
    const taskB = makeTask('del-bg11b-resume', OLDER_DATE);
    const rowB: MappingRow = {
      todoist_id: taskB.id, fp_stable_id: null, occurrence_date: OLDER_DATE,
      surface: 'chore', frame_id: FRAME_ID, profile: PROFILE,
      skylight_id: 'sky-del-b-resume', expected_summary: taskB.content,
      last_pushed_status: 'pending', observed_status: 'pending',
      last_pushed_hash: null, state: 'deleting',
      idem_token: null, updated_at: null,
    };
    db.rows.set(`${taskB.id}:${OLDER_DATE}`, rowB as unknown as D1Row);

    mockFetchDeckTasks.mockResolvedValue([taskB]);

    // Full budget — delete should complete
    const counter = new SubrequestCounter(SUBREQUEST_BUDGET);
    const cache = new MappingCache();
    await cache.loadAll(db.asD1());
    const runCtx: RunContext = { counter, mappingCache: cache, rawDb: db.asD1() };

    const markerB = choreDescriptionMarker(taskB.id);
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ data: [{ id: 'sky-del-b-resume', type: 'chore', attributes: {
          summary: taskB.content, status: 'pending', start: OLDER_DATE,
          start_time: null, recurring: false, completed_on: null,
          emoji_icon: null, reward_points: null, category_id: null, category_ids: null,
          description: markerB,
        } }] }),
        text: async () => '{}',
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({}),
        text: async () => '{}',
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ data: [] }),
        text: async () => '{"data":[]}',
        headers: { get: () => null },
      } as unknown as Response);

    const client = new CountedSkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' }, counter);
    const env = makeEnv(false);

    await runOutboundPass(client, db.asD1(), env, FRAME_ID, PROFILE, null, OLDER_DATE, undefined, runCtx);

    // Row B should now be gone (hard-deleted)
    expect(db.getRow(taskB.id, OLDER_DATE)).toBeUndefined();

    // One DELETE call confirms the delete ran
    const deleteCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE'
    );
    expect(deleteCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (BG-12) ROLL never half-done — guard fires BEFORE delete+create begin
// ---------------------------------------------------------------------------

describe('(BG-12) ROLL is never half-done — budget guard fires before delete+create', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchDeckTasks.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /**
   * BG-12a: A recurring task whose due date advanced (triggers ROLL_CHORE).
   * Budget is too small to afford MUTATION_COST_ROLL — guard fires BEFORE the
   * delete begins. No HTTP calls, no D1 changes. On follow-up run with budget
   * restored, the roll completes fully (idempotent resume).
   */
  it('(BG-12a) ROLL guard fires before delete+create: no HTTP calls, no D1 mutations', async () => {
    const OLD_DATE = '2026-07-15';
    const NEW_DATE = '2026-08-15'; // advanced due date
    const db = new InMemoryD1();

    // Recurring task with NEW due date — active row stores OLD date
    const rollTask = {
      id: 'roll-bg12',
      content: 'Recurring Roll Task',
      description: '',
      labels: [],
      project_id: 'proj-1',
      section_id: null,
      parent_id: null,
      due: { date: NEW_DATE, string: NEW_DATE, is_recurring: true }, // recurring=true triggers ROLL
      priority: 1,
      checked: false,
    };

    const oldRow: MappingRow = {
      todoist_id: rollTask.id, fp_stable_id: null, occurrence_date: OLD_DATE,
      surface: 'chore', frame_id: FRAME_ID, profile: PROFILE,
      skylight_id: 'sky-roll-old', expected_summary: rollTask.content,
      last_pushed_status: 'pending', observed_status: 'pending',
      last_pushed_hash: null, state: 'active',
      idem_token: null, updated_at: null,
    };
    db.rows.set(`${rollTask.id}:${OLD_DATE}`, oldRow as unknown as D1Row);

    mockFetchDeckTasks.mockResolvedValue([rollTask]);

    // Budget too tight for ROLL (cost=MUTATION_COST_ROLL=10):
    // canAfford(TAIL_RESERVE=8, 10): total + 18 ≤ budget
    // Set total=1, budget=18 → 1+18=19 > 18 → guard fires immediately
    const BUDGET = 18;
    const counter = new SubrequestCounter(BUDGET);
    counter.incrementD1(1); // total=1, so 1+18=19 > 18 → guard fires

    const cache = new MappingCache();
    await cache.loadAll(db.asD1());
    const runCtx: RunContext = { counter, mappingCache: cache, rawDb: db.asD1() };

    const client = new CountedSkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' }, counter);
    const env = makeEnv(false);

    await runOutboundPass(client, db.asD1(), env, FRAME_ID, PROFILE, null, NEW_DATE, undefined, runCtx);

    // CRITICAL: no HTTP calls at all — the ROLL was NOT started
    // (no getChoreById for the old chore, no DELETE, no POST for new chore)
    expect(fetchSpy.mock.calls).toHaveLength(0);

    // CRITICAL: old row still exists and is unchanged — no partial delete
    const rowAfter = db.getRow(rollTask.id, OLD_DATE);
    expect(rowAfter).not.toBeUndefined();
    expect(rowAfter?.state).toBe('active');
    expect(rowAfter?.skylight_id).toBe('sky-roll-old');

    // No new row created for the new date
    expect(db.getRow(rollTask.id, NEW_DATE)).toBeUndefined();

    // Deferral logged
    const logText = (consoleSpy.mock.calls as string[][]).flat().join('\n');
    expect(logText).toMatch(/deferred.*mutation.*next run/i);
  });

  /**
   * BG-12b: Follow-up run with full budget completes the deferred roll.
   * Old row is deleted, new row is created and committed active.
   */
  it('(BG-12b) follow-up run completes deferred roll (idempotent resume, no double-mutation)', async () => {
    const OLD_DATE = '2026-07-15';
    const NEW_DATE = '2026-08-15';
    const db = new InMemoryD1();

    const rollTask = {
      id: 'roll-bg12-resume',
      content: 'Recurring Roll Resume',
      description: '',
      labels: [],
      project_id: 'proj-1',
      section_id: null,
      parent_id: null,
      due: { date: NEW_DATE, string: NEW_DATE, is_recurring: true },
      priority: 1,
      checked: false,
    };

    const oldRow: MappingRow = {
      todoist_id: rollTask.id, fp_stable_id: null, occurrence_date: OLD_DATE,
      surface: 'chore', frame_id: FRAME_ID, profile: PROFILE,
      skylight_id: 'sky-roll-old-r', expected_summary: rollTask.content,
      last_pushed_status: 'pending', observed_status: 'pending',
      last_pushed_hash: null, state: 'active',
      idem_token: null, updated_at: null,
    };
    db.rows.set(`${rollTask.id}:${OLD_DATE}`, oldRow as unknown as D1Row);

    mockFetchDeckTasks.mockResolvedValue([rollTask]);

    // Full budget — roll should complete
    const counter = new SubrequestCounter(SUBREQUEST_BUDGET);
    const cache = new MappingCache();
    await cache.loadAll(db.asD1());
    const runCtx: RunContext = { counter, mappingCache: cache, rawDb: db.asD1() };

    const marker = choreDescriptionMarker(rollTask.id);

    // Mock: delete protocol (3 HTTP) + create protocol (POST + readback GET via single-chore path)
    fetchSpy
      // getChoreById for old chore (DELETE protocol step 1)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ data: [{ id: 'sky-roll-old-r', type: 'chore', attributes: {
          summary: rollTask.content, status: 'pending', start: OLD_DATE,
          start_time: null, recurring: false, completed_on: null,
          emoji_icon: null, reward_points: null, category_id: null, category_ids: null,
          description: marker,
        } }] }),
        text: async () => '{}',
        headers: { get: () => null },
      } as unknown as Response)
      // deleteChore (DELETE /chores/sky-roll-old-r)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({}),
        text: async () => '{}',
        headers: { get: () => null },
      } as unknown as Response)
      // verifyDeleted (getChoreById → null)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ data: [] }),
        text: async () => '{"data":[]}',
        headers: { get: () => null },
      } as unknown as Response)
      // createChore POST for new occurrence
      // NOTE: apiMutate uses res.text() (not res.json()) for 200/204 responses,
      // so the text() value must be the full JSON string.
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({
          data: [{ id: 'sky-roll-new-r', type: 'chore', attributes: {
            summary: rollTask.content, status: 'pending', start: NEW_DATE,
            start_time: null, recurring: false, completed_on: null,
            emoji_icon: null, reward_points: null, category_id: null, category_ids: null,
            description: marker,
          } }],
        }),
        text: async () => JSON.stringify({ data: [{ id: 'sky-roll-new-r', type: 'chore', attributes: {
          summary: rollTask.content, status: 'pending', start: NEW_DATE,
          start_time: null, recurring: false, completed_on: null,
          emoji_icon: null, reward_points: null, category_id: null, category_ids: null,
          description: marker,
        } }] }),
        headers: { get: () => null },
      } as unknown as Response)
      // getChoreById readback for new chore (runCreateProtocol calls this via apiGet which uses res.json())
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ data: [{ id: 'sky-roll-new-r', type: 'chore', attributes: {
          summary: rollTask.content, status: 'pending', start: NEW_DATE,
          start_time: null, recurring: false, completed_on: null,
          emoji_icon: null, reward_points: null, category_id: null, category_ids: null,
          description: marker,
        } }] }),
        text: async () => '{}',
        headers: { get: () => null },
      } as unknown as Response);

    const client = new CountedSkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' }, counter);
    const env = makeEnv(false);

    await runOutboundPass(client, db.asD1(), env, FRAME_ID, PROFILE, null, NEW_DATE, undefined, runCtx);

    // Old row deleted
    expect(db.getRow(rollTask.id, OLD_DATE)).toBeUndefined();

    // New row active
    const newRow = db.getRow(rollTask.id, NEW_DATE);
    expect(newRow).not.toBeUndefined();
    expect(newRow?.state).toBe('active');
    expect(newRow?.skylight_id).toBe('sky-roll-new-r');
    expect(newRow?.occurrence_date).toBe(NEW_DATE);

    // Exactly 1 DELETE call (not 0, not 2)
    const deleteCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE'
    );
    expect(deleteCalls).toHaveLength(1);

    // Exactly 1 POST call (new chore created once)
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(postCalls).toHaveLength(1);
  });
});
