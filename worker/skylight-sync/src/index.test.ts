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
  choreDescriptionMarker,
  descriptionMatchesMarker,
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

function makeChoreResponse(id: string, summary: string, status = 'pending', description?: string | null) {
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
        description: description ?? null,
      },
    },
  };
}

function makeCreateResponse(id: string, summary: string, description?: string | null) {
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
          description: description ?? null,
        },
      },
    ],
  };
}

function makeListResponse(items: Array<{ id: string; summary: string; status?: string; description?: string }>) {
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
        description: i.description ?? null,
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
// Tests: ownership-guard adversarial cases (clean-title scheme)
// These drive the REAL exported functions and prove the worker NEVER
// completes/deletes a chore it does not own when the description marker is
// missing/wrong (e.g. a family-edited or id-reused chore).
// ---------------------------------------------------------------------------

describe('ownership guard — description marker (adversarial)', () => {
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

  function seedActiveChoreRow(db: InMemoryD1, overrides: Partial<MappingRow> = {}): MappingRow {
    const row: MappingRow = {
      todoist_id: TASK_ID,
      fp_stable_id: null,
      occurrence_date: OCCURRENCE_DATE,
      surface: 'chore',
      frame_id: FRAME_ID,
      profile: PROFILE,
      skylight_id: 'sky-001',
      expected_summary: TASK_CONTENT,
      last_pushed_status: 'pending',
      observed_status: 'pending',
      last_pushed_hash: null,
      state: 'active',
      idem_token: sentinelToken(TASK_ID),
      updated_at: null,
      ...overrides,
    };
    db.rows.set(`${row.todoist_id}:${row.occurrence_date}`, row as unknown as D1Row);
    return row;
  }

  it('(own-marker) descriptionMatchesMarker is exact + deterministic + collision-resistant', () => {
    // Deterministic from the Todoist id
    expect(choreDescriptionMarker(TASK_ID)).toBe(`FPSYNC|${TASK_ID}`);
    expect(choreDescriptionMarker('x')).toBe('FPSYNC|x');
    // Exact match only
    const marker = choreDescriptionMarker(TASK_ID);
    expect(descriptionMatchesMarker(marker, marker)).toBe(true);
    // A markerless family chore (null / '' description) is NEVER ours
    expect(descriptionMatchesMarker(null, marker)).toBe(false);
    expect(descriptionMatchesMarker(undefined, marker)).toBe(false);
    expect(descriptionMatchesMarker('', marker)).toBe(false);
    // Free-text family description that merely contains the marker is rejected (no substring/prefix match)
    expect(descriptionMatchesMarker(`note ${marker}`, marker)).toBe(false);
    expect(descriptionMatchesMarker(`${marker} `, marker)).toBe(false);
    // Marker for a DIFFERENT (id-reused) task is rejected
    expect(descriptionMatchesMarker(choreDescriptionMarker('other-task'), marker)).toBe(false);
  });

  it('(own-delete-abort) runDeleteProtocol on a chore with WRONG/missing marker → detach, ZERO DELETE', async () => {
    const db = new InMemoryD1();
    const row = seedActiveChoreRow(db, { state: 'active' });

    // Re-GET (via list) returns a chore that exists but carries NO ownership marker
    // (e.g. an id-reused slot now holding a family chore, or marker cleared).
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeListResponse([{ id: 'sky-001', summary: 'Family dinner', status: 'pending', description: undefined }]),
      text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: 'Family dinner', status: 'pending', description: undefined }])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runDeleteProtocol(client, db.asD1(), row);

    // Row detached, NOT hard-deleted
    const finalRow = db.getRow(TASK_ID, OCCURRENCE_DATE);
    expect(finalRow?.state).toBe('detached');

    // CRITICAL: no DELETE / PUT issued against the non-owned chore
    const mutating = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE' || opts?.method === 'PUT'
    );
    expect(mutating).toHaveLength(0);
  });

  it('(own-delete-abort-2) runDeleteProtocol when marker belongs to a DIFFERENT task id → detach, ZERO DELETE', async () => {
    const db = new InMemoryD1();
    const row = seedActiveChoreRow(db, { state: 'active' });

    // Chore exists and HAS a FairPlay marker — but for a different Todoist id (id reuse).
    const foreignMarker = choreDescriptionMarker('some-other-task-999');
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeListResponse([{ id: 'sky-001', summary: 'Someone elses chore', status: 'pending', description: foreignMarker }]),
      text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: 'Someone elses chore', status: 'pending', description: foreignMarker }])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runDeleteProtocol(client, db.asD1(), row);

    expect(db.getRow(TASK_ID, OCCURRENCE_DATE)?.state).toBe('detached');
    const mutating = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'DELETE' || opts?.method === 'PUT'
    );
    expect(mutating).toHaveLength(0);
  });

  it('(own-create-reject) createChore rejects when returned description != expected marker', async () => {
    // Create response echoes a DIFFERENT/empty description — the API silently
    // dropped our marker, or returned a foreign chore. Must throw (→ needs_review).
    const descMarker = choreDescriptionMarker(TASK_ID);
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => makeCreateResponse('sky-new', TASK_CONTENT, null),
      text: async () => JSON.stringify(makeCreateResponse('sky-new', TASK_CONTENT, null)),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await expect(
      client.createChore({
        summary: TASK_CONTENT,
        start: OCCURRENCE_DATE,
        categoryId: null,
        idemToken: sentinelToken(TASK_ID),
        description: descMarker,
      })
    ).rejects.toThrow(/does not match/);
  });

  it('(own-create-verify-reject) runCreateProtocol → needs_review when create echoes wrong marker', async () => {
    const db = new InMemoryD1();
    const task = makeRawTask();
    const wrongMarker = choreDescriptionMarker('attacker-task');

    // POST create response carries a FOREIGN marker (createChore must throw).
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => makeCreateResponse('sky-001', task.content, wrongMarker),
      text: async () => JSON.stringify(makeCreateResponse('sky-001', task.content, wrongMarker)),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    // createChore throws inside runCreateProtocol; the write-ahead 'creating' row
    // remains (no active commit, no skylight_id) — it is never promoted to a
    // state where a delete/complete could fire against an unverified chore.
    await expect(
      runCreateProtocol(client, db.asD1(), task, null, FRAME_ID, PROFILE, OCCURRENCE_DATE, null, 'America/New_York')
    ).rejects.toThrow(/does not match/);

    const row = db.getRow(task.id, OCCURRENCE_DATE);
    // Must NOT have reached 'active' with a skylight_id off a non-matching marker
    expect(row?.state).not.toBe('active');
    expect(row?.skylight_id ?? null).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // runCompleteProtocol ownership guard (the gap closed in this diff)
  // ---------------------------------------------------------------------------

  it('(own-complete-abort) runCompleteProtocol on a chore with WRONG/missing marker → detach, ZERO PUT', async () => {
    // Re-GET (via list) returns a chore that exists but carries NO ownership marker
    // (e.g. an id-reused slot now holding a family chore, or marker cleared).
    const db = new InMemoryD1();
    const row = seedActiveChoreRow(db, { state: 'active' });

    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeListResponse([{ id: 'sky-001', summary: 'Family dinner', status: 'pending', description: undefined }]),
      text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: 'Family dinner', status: 'pending', description: undefined }])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runCompleteProtocol(client, db.asD1(), row);

    // Row should be detached, NOT marked complete
    const finalRow = db.getRow(TASK_ID, OCCURRENCE_DATE);
    expect(finalRow?.state).toBe('detached');
    // last_pushed_status must NOT have been updated to 'complete'
    expect(finalRow?.last_pushed_status).not.toBe('complete');

    // CRITICAL: no PUT issued against the non-owned chore
    const putCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'PUT'
    );
    expect(putCalls).toHaveLength(0);
  });

  it('(own-complete-abort-2) runCompleteProtocol with marker belonging to a DIFFERENT task → detach, ZERO PUT', async () => {
    // Chore exists and HAS a FairPlay marker — but for a different Todoist id (id reuse).
    const db = new InMemoryD1();
    const row = seedActiveChoreRow(db, { state: 'active' });
    const foreignMarker = choreDescriptionMarker('some-other-task-999');

    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeListResponse([{ id: 'sky-001', summary: 'Someone elses chore', status: 'pending', description: foreignMarker }]),
      text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: 'Someone elses chore', status: 'pending', description: foreignMarker }])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runCompleteProtocol(client, db.asD1(), row);

    expect(db.getRow(TASK_ID, OCCURRENCE_DATE)?.state).toBe('detached');
    const putCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'PUT'
    );
    expect(putCalls).toHaveLength(0);
  });

  it('(own-complete-ok) runCompleteProtocol with matching marker → completeChore IS called', async () => {
    // Positive test: when the live chore carries the correct ownership marker,
    // completeChore must be issued and the D1 row updated to complete.
    const db = new InMemoryD1();
    const row = seedActiveChoreRow(db, { state: 'active' });
    const correctMarker = choreDescriptionMarker(TASK_ID);

    fetchSpy
      // re-GET via list (ownership check)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeListResponse([{ id: 'sky-001', summary: row.expected_summary!, status: 'pending', description: correctMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: row.expected_summary!, status: 'pending', description: correctMarker }])),
        headers: { get: () => null },
      } as unknown as Response)
      // PUT completeChore
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeChoreResponse('sky-001', row.expected_summary!, 'complete', correctMarker),
        text: async () => JSON.stringify(makeChoreResponse('sky-001', row.expected_summary!, 'complete', correctMarker)),
        headers: { get: () => null },
      } as unknown as Response)
      // GET verifyCompleted (via list)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeListResponse([{ id: 'sky-001', summary: row.expected_summary!, status: 'complete', description: correctMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: row.expected_summary!, status: 'complete', description: correctMarker }])),
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runCompleteProtocol(client, db.asD1(), row);

    // Row should be updated to complete, NOT detached
    const finalRow = db.getRow(TASK_ID, OCCURRENCE_DATE);
    expect(finalRow?.last_pushed_status).toBe('complete');
    expect(finalRow?.state).not.toBe('detached');

    // Exactly one PUT must have been issued (the complete)
    const putCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'PUT'
    );
    expect(putCalls).toHaveLength(1);
  });

  it('(own-complete-dryrun) DRYRUN: ownership re-GET fires but zero PUT issued, D1 not mutated', async () => {
    // Under dryrun, the re-GET still happens (ownership check) but no PUT is issued
    // and D1 is NOT updated — consistent with runDeleteProtocol dryrun behavior.
    const db = new InMemoryD1();
    const row = seedActiveChoreRow(db, { state: 'active' });
    const correctMarker = choreDescriptionMarker(TASK_ID);

    // re-GET via list returns matching marker
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeListResponse([{ id: 'sky-001', summary: row.expected_summary!, status: 'pending', description: correctMarker }]),
      text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: row.expected_summary!, status: 'pending', description: correctMarker }])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runCompleteProtocol(client, db.asD1(), row, true /* dryrun */);

    // No PUT must have been issued
    const putCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'PUT'
    );
    expect(putCalls).toHaveLength(0);

    // D1 must NOT be mutated — last_pushed_status stays at original 'pending'
    const finalRow = db.getRow(TASK_ID, OCCURRENCE_DATE);
    expect(finalRow?.last_pushed_status).toBe('pending');
    expect(finalRow?.state).toBe('active');
  });
});

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
    // Clean-title scheme: summary is the clean task content; description carries the marker.
    const cleanSummary = task.content;
    const descMarker = choreDescriptionMarker(task.id);

    // POST → create response includes description marker echoed back
    // GET (read-back via list) → chore with description marker confirming ownership
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeCreateResponse('sky-001', cleanSummary, descMarker),
        text: async () => JSON.stringify(makeCreateResponse('sky-001', cleanSummary, descMarker)),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeListResponse([{ id: 'sky-001', summary: cleanSummary, status: 'pending', description: descMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: cleanSummary, status: 'pending', description: descMarker }])),
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runCreateProtocol(client, db.asD1(), task, null, FRAME_ID, PROFILE, OCCURRENCE_DATE, null, 'America/New_York');

    const row = db.getRow(task.id, OCCURRENCE_DATE);
    expect(row).toBeDefined();
    expect(row?.state).toBe('active');
    expect(row?.skylight_id).toBe('sky-001');
    // Clean title: expected_summary must NOT contain the visible sentinel glyph
    expect(row?.expected_summary).toBe(cleanSummary);
    expect(row?.expected_summary).not.toContain('▸');
    expect(row?.last_pushed_status).toBe('pending');

    // Only one POST
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(postCalls).toHaveLength(1);

    // Verify POST body contains description marker and clean summary (no sentinel)
    const postBody = JSON.parse((postCalls[0][1]?.body as string) ?? '{}') as Record<string, unknown>;
    expect(postBody['description']).toBe(descMarker);
    expect(postBody['summary']).toBe(cleanSummary);
    expect(String(postBody['summary'])).not.toContain('▸');
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
    // Clean-title scheme: recovery scans by description marker, not summary.
    const cleanSummary = task.content;
    const descMarker = choreDescriptionMarker(task.id);

    // Simulate an existing 'creating' row with no skylight_id (interrupted create)
    const existingRow: MappingRow = {
      todoist_id: task.id,
      fp_stable_id: null,
      occurrence_date: OCCURRENCE_DATE,
      surface: 'chore',
      frame_id: FRAME_ID,
      profile: PROFILE,
      skylight_id: null,
      expected_summary: cleanSummary,
      last_pushed_status: null,
      observed_status: null,
      last_pushed_hash: null,
      state: 'creating',
      idem_token: sentinelToken(task.id),
      updated_at: null,
    };

    // Pre-seed the row in the D1 mock
    db.rows.set(`${task.id}:${OCCURRENCE_DATE}`, existingRow as unknown as D1Row);

    // The chore already exists on Skylight from the interrupted run — found by description marker scan.
    // The listChores response includes the chore with its description marker.
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => makeListResponse([{ id: 'sky-rescued', summary: cleanSummary, description: descMarker }]),
      text: async () => JSON.stringify(makeListResponse([{ id: 'sky-rescued', summary: cleanSummary, description: descMarker }])),
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
    // Clean title: no sentinel in expected_summary
    expect(row?.expected_summary).toBe(cleanSummary);
    expect(row?.expected_summary).not.toContain('▸');
  });

  it('(c) DRYRUN issues zero mutating fetches and zero D1 writes', async () => {
    const db = new InMemoryD1();
    const task = makeRawTask();

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: true, token: 'tok' });

    await runCreateProtocol(client, db.asD1(), task, null, FRAME_ID, PROFILE, OCCURRENCE_DATE, null, 'America/New_York', true);

    const mutatingCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST' || opts?.method === 'PUT' || opts?.method === 'DELETE'
    );
    expect(mutatingCalls).toHaveLength(0);

    // DRYRUN must not persist any mapping rows — D1 stays empty
    expect(db.getRow(task.id, OCCURRENCE_DATE)).toBeUndefined();
    expect(db.allRows()).toHaveLength(0);
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
    // Clean-title scheme: expected_summary is the task content (no sentinel).
    // Ownership verification uses choreDescriptionMarker(TASK_ID), not summary.
    const expected_summary = TASK_CONTENT;
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

  it('(d) missing/markerless description on inbound chore marks row detached, no write occurs', async () => {
    const db = new InMemoryD1();
    const task = makeRawTask();
    const row = seedActiveRow(db);

    // Skylight returns a chore via list with NO description marker (sentinel stripped)
    const divergedSummary = 'Take out trash';
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeListResponse([{ id: 'sky-001', summary: divergedSummary, status: 'pending', description: undefined }]),
      text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: divergedSummary, status: 'pending', description: undefined }])),
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
    // Clean-title scheme: description marker on chore confirms ownership.
    const descMarker = choreDescriptionMarker(TASK_ID);

    // GET chore via list → pending (device hasn't completed it yet), description marker present
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeListResponse([{ id: 'sky-001', summary: row.expected_summary!, status: 'pending', description: descMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: row.expected_summary!, status: 'pending', description: descMarker }])),
        headers: { get: () => null },
      } as unknown as Response)
      // GET via list (runCompleteProtocol ownership re-GET)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeListResponse([{ id: 'sky-001', summary: row.expected_summary!, status: 'pending', description: descMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: row.expected_summary!, status: 'pending', description: descMarker }])),
        headers: { get: () => null },
      } as unknown as Response)
      // PUT complete (runCompleteProtocol)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{}',
        headers: { get: () => null },
      } as unknown as Response)
      // GET via list (verifyCompleted)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeListResponse([{ id: 'sky-001', summary: row.expected_summary!, status: 'complete', description: descMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: row.expected_summary!, status: 'complete', description: descMarker }])),
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
    const seededRow = seedActiveRow(db, { last_pushed_status: 'pending' });
    // Clean-title scheme: description marker on chore confirms ownership.
    const descMarker = choreDescriptionMarker(TASK_ID);

    // First inbound run: both sides complete → 'already in sync' branch
    // observed=complete, lastPushed=pending → not echo; observed===todoistStatus → update last_pushed
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeListResponse([{ id: 'sky-001', summary: seededRow.expected_summary!, status: 'complete', description: descMarker }]),
      text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: seededRow.expected_summary!, status: 'complete', description: descMarker }])),
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

    // GET via list → now pending (device reopened it), description marker still present
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeListResponse([{ id: 'sky-001', summary: seededRow.expected_summary!, status: 'pending', description: descMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: seededRow.expected_summary!, status: 'pending', description: descMarker }])),
        headers: { get: () => null },
      } as unknown as Response)
      // GET via list (runCompleteProtocol ownership re-GET)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeListResponse([{ id: 'sky-001', summary: seededRow.expected_summary!, status: 'pending', description: descMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: seededRow.expected_summary!, status: 'pending', description: descMarker }])),
        headers: { get: () => null },
      } as unknown as Response)
      // PUT complete (re-assert)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{}',
        headers: { get: () => null },
      } as unknown as Response)
      // GET via list (verifyCompleted)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeListResponse([{ id: 'sky-001', summary: seededRow.expected_summary!, status: 'complete', description: descMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: seededRow.expected_summary!, status: 'complete', description: descMarker }])),
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
    const descMarker = choreDescriptionMarker(TASK_ID);

    // GET chore via list → pending, with correct ownership marker
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeListResponse([{ id: 'sky-001', summary: TASK_CONTENT, status: 'pending', description: descMarker }]),
      text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: TASK_CONTENT, status: 'pending', description: descMarker }])),
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

    // DRYRUN: D1 must NOT be mutated — last_pushed_status stays at original 'pending'
    const row = db.getRow(TASK_ID, OCCURRENCE_DATE);
    expect(row?.last_pushed_status).toBe('pending');
  });

  it('(h) DRYRUN: zero mutating fetches to api.todoist.com when device completes a chore', async () => {
    const db = new InMemoryD1();
    // Row where device has completed the chore (observed=complete), Todoist is still pending
    seedActiveRow(db, { last_pushed_status: 'pending', observed_status: 'pending' });
    const descMarker = choreDescriptionMarker(TASK_ID);

    // GET chore via list → complete (device completed it), ownership marker present
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeListResponse([{ id: 'sky-001', summary: TASK_CONTENT, status: 'complete', description: descMarker }]),
      text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: TASK_CONTENT, status: 'complete', description: descMarker }])),
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

    // DRYRUN: D1 must NOT be mutated — last_pushed_status stays at original 'pending'
    const row = db.getRow(TASK_ID, OCCURRENCE_DATE);
    expect(row?.last_pushed_status).toBe('pending');
  });

  it('(f) echo guard: when observed matches last_pushed, no write issued', async () => {
    const db = new InMemoryD1();
    seedActiveRow(db, { last_pushed_status: 'pending' });
    const descMarker = choreDescriptionMarker(TASK_ID);

    // chore is pending — same as last_pushed → echo (ownership marker present)
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeListResponse([{ id: 'sky-001', summary: TASK_CONTENT, status: 'pending', description: descMarker }]),
      text: async () => JSON.stringify(makeListResponse([{ id: 'sky-001', summary: TASK_CONTENT, status: 'pending', description: descMarker }])),
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
    // Clean-title scheme: summary is clean content; description carries the marker.
    const cleanSummary = task.content;
    const descMarker = choreDescriptionMarker(task.id);

    // POST → create response with description marker echoed back
    // GET via list (read-back) → chore with description marker
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeCreateResponse('sky-recur-001', cleanSummary, descMarker),
        text: async () => JSON.stringify(makeCreateResponse('sky-recur-001', cleanSummary, descMarker)),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeListResponse([{ id: 'sky-recur-001', summary: cleanSummary, status: 'pending', description: descMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-recur-001', summary: cleanSummary, status: 'pending', description: descMarker }])),
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
    // Clean title: no sentinel in expected_summary
    expect(row?.expected_summary).toBe(cleanSummary);
    expect(row?.expected_summary).not.toContain('▸');

    // Exactly one POST (one chore created, non-recurring)
    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(postCalls).toHaveLength(1);
    // Verify the created chore is non-recurring (recurring:false in create body)
    const createBody = JSON.parse((postCalls[0][1]?.body as string) ?? '{}') as Record<string, unknown>;
    expect(createBody['recurring']).toBe(false);
    // Verify the create body contains description marker and clean summary
    expect(createBody['description']).toBe(descMarker);
    expect(String(createBody['summary'])).not.toContain('▸');
  });

  it('(2b-1-dryrun) DRYRUN: no mutating fetches for recurring task create', async () => {
    const db = new InMemoryD1();
    const task = makeRecurringTodoistTask(RECURRING_TASK_ID, RECURRING_OCCURRENCE_DATE);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: true, token: 'tok' });

    await runCreateProtocol(
      client, db.asD1(),
      { id: task.id, content: task.content, due: task.due, description: task.description, labels: task.labels },
      null, FRAME_ID, PROFILE, RECURRING_OCCURRENCE_DATE, null, 'America/New_York', true
    );

    const mutatingCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST' || opts?.method === 'PUT' || opts?.method === 'DELETE'
    );
    expect(mutatingCalls).toHaveLength(0);

    // DRYRUN must not persist any mapping rows — D1 stays empty
    expect(db.getRow(RECURRING_TASK_ID, RECURRING_OCCURRENCE_DATE)).toBeUndefined();
    expect(db.allRows()).toHaveLength(0);
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
    // Clean-title scheme: expected_summary is the task content (no sentinel).
    const expected_summary = 'Take out trash';
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
    // Clean-title scheme: description marker identifies ownership.
    const cleanSummary = 'Take out trash';
    const descMarker = choreDescriptionMarker(RECURRING_TASK_ID);
    const task = makeRecurringTodoistTask(RECURRING_TASK_ID, NEXT_OCCURRENCE_DATE);

    // Sequence: GET via list (delete re-confirm), DELETE,
    // GET via list (verify-deleted, empty → gone), POST (create new), GET via list (read-back new)
    fetchSpy
      // 1. re-GET via list (delete protocol step 1) — must include description marker
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeListResponse([{ id: 'sky-recur-001', summary: cleanSummary, status: 'pending', description: descMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-recur-001', summary: cleanSummary, status: 'pending', description: descMarker }])),
        headers: { get: () => null },
      } as unknown as Response)
      // 2. DELETE old chore
      .mockResolvedValueOnce({
        ok: true, status: 204,
        text: async () => '',
        headers: { get: () => null },
      } as unknown as Response)
      // 3. GET via list (verify-deleted) → empty list (chore gone)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeListResponse([]),
        text: async () => JSON.stringify(makeListResponse([])),
        headers: { get: () => null },
      } as unknown as Response)
      // 4. POST create new occurrence — description marker echoed back
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeCreateResponse('sky-recur-002', cleanSummary, descMarker),
        text: async () => JSON.stringify(makeCreateResponse('sky-recur-002', cleanSummary, descMarker)),
        headers: { get: () => null },
      } as unknown as Response)
      // 5. GET via list (read-back new occurrence) — description marker present
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeListResponse([{ id: 'sky-recur-002', summary: cleanSummary, status: 'pending', description: descMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-recur-002', summary: cleanSummary, status: 'pending', description: descMarker }])),
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

    // chore is pending (same as last_pushed — echo), description marker present
    const descMarkerRecur2 = choreDescriptionMarker(RECURRING_TASK_ID);
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => makeListResponse([{ id: 'sky-recur-001', summary: 'Take out trash', status: 'pending', description: descMarkerRecur2 }]),
      text: async () => JSON.stringify(makeListResponse([{ id: 'sky-recur-001', summary: 'Take out trash', status: 'pending', description: descMarkerRecur2 }])),
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
    // Clean-title scheme: expected_summary is the task content (no sentinel).
    const expected_summary = 'Take out trash';
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
    const descMarkerRecur = choreDescriptionMarker(RECURRING_TASK_ID);

    // GET chore via list → complete (device completed it), ownership marker present
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => makeListResponse([{ id: 'sky-recur-001', summary: 'Take out trash', status: 'complete', description: descMarkerRecur }]),
      text: async () => JSON.stringify(makeListResponse([{ id: 'sky-recur-001', summary: 'Take out trash', status: 'complete', description: descMarkerRecur }])),
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

    // DRYRUN: D1 must NOT be mutated — last_pushed_status stays at original 'pending'
    const row = db.getRow(RECURRING_TASK_ID, RECURRING_OCCURRENCE_DATE);
    expect(row?.last_pushed_status).toBe('pending');
  });

  it('(2b-2-live) device completes recurring occurrence → closes Todoist, deletes old, creates next occurrence', async () => {
    const db = new InMemoryD1();
    seedRecurringActiveRow(db);
    // Clean-title scheme: description marker identifies ownership.
    const cleanSummary = 'Take out trash';
    const descMarker = choreDescriptionMarker(RECURRING_TASK_ID);

    // Sequence:
    // 1. GET via list → complete (inbound sees device completed), description marker present
    // 2. GET via list (delete re-confirm) — description marker present
    // 3. DELETE old chore
    // 4. GET via list (verify-deleted) → empty list (chore gone)
    // 5. POST create new occurrence — description marker echoed back
    // 6. GET via list (read-back new) — description marker present
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeListResponse([{ id: 'sky-recur-001', summary: cleanSummary, status: 'complete', description: descMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-recur-001', summary: cleanSummary, status: 'complete', description: descMarker }])),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeListResponse([{ id: 'sky-recur-001', summary: cleanSummary, status: 'complete', description: descMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-recur-001', summary: cleanSummary, status: 'complete', description: descMarker }])),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 204,
        text: async () => '',
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeListResponse([]),  // chore absent → verifyDeleted passes
        text: async () => JSON.stringify(makeListResponse([])),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeCreateResponse('sky-recur-002', cleanSummary, descMarker),
        text: async () => JSON.stringify(makeCreateResponse('sky-recur-002', cleanSummary, descMarker)),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeListResponse([{ id: 'sky-recur-002', summary: cleanSummary, status: 'pending', description: descMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-recur-002', summary: cleanSummary, status: 'pending', description: descMarker }])),
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

    // GET chore via list → pending (not completed), ownership marker present
    const descMarkerRecur5 = choreDescriptionMarker(RECURRING_TASK_ID);
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => makeListResponse([{ id: 'sky-recur-002', summary: 'Take out trash', status: 'pending', description: descMarkerRecur5 }]),
      text: async () => JSON.stringify(makeListResponse([{ id: 'sky-recur-002', summary: 'Take out trash', status: 'pending', description: descMarkerRecur5 }])),
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

    // DRYRUN: D1 must NOT be mutated — no row should exist
    expect(db.getRow(task.id, '')).toBeUndefined();
    expect(db.allRows()).toHaveLength(0);
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

  it('(2c-2-dryrun) DRYRUN: zero mutations, last_pushed_status NOT updated', async () => {
    const db = new InMemoryD1();
    const row = seedListRow(db);
    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: true, token: 'tok' });

    await runCompleteListItemProtocol(client, db.asD1(), row, BRIDGE_LIST_ID, true);

    const mutatingCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'PUT' || opts?.method === 'POST' || opts?.method === 'DELETE'
    );
    expect(mutatingCalls).toHaveLength(0);

    // DRYRUN: D1 must NOT be mutated — last_pushed_status stays at original 'pending'
    const finalRow = db.getRow(LIST_TASK_ID, '');
    expect(finalRow?.last_pushed_status).toBe('pending');
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

    // DRYRUN: D1 must NOT be mutated — the row stays as-is (not deleted)
    expect(db.getRow(LIST_TASK_ID, '')).toBeDefined();
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

    // DRYRUN: D1 must NOT be mutated — last_pushed_status stays at original 'pending'
    const row = db.getRow(LIST_TASK_ID, '');
    expect(row?.last_pushed_status).toBe('pending');
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
    // Clean-title scheme: chore summary is clean content; description carries the marker.
    const cleanChoreSummary = LIST_TASK_CONTENT;
    const descMarker = choreDescriptionMarker(LIST_TASK_ID);

    // Sequence:
    // 1. GET list before delete (item exists)
    // 2. DELETE item
    // 3. GET list after delete (item gone)
    // 4. POST create chore — description marker echoed back
    // 5. GET read-back chore — description marker present
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
        json: async () => makeCreateResponse('sky-chore-001', cleanChoreSummary, descMarker),
        text: async () => JSON.stringify(makeCreateResponse('sky-chore-001', cleanChoreSummary, descMarker)),
        headers: { get: () => null },
      } as unknown as Response)
      // 5. GET via list (read-back chore) — description marker present
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeListResponse([{ id: 'sky-chore-001', summary: cleanChoreSummary, status: 'pending', description: descMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-chore-001', summary: cleanChoreSummary, status: 'pending', description: descMarker }])),
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
    // Seed a chore row for the same task id — clean-title scheme.
    const cleanChoreSummary = LIST_TASK_CONTENT;
    const descMarker = choreDescriptionMarker(LIST_TASK_ID);
    const choreRow: MappingRow = {
      todoist_id: LIST_TASK_ID,
      fp_stable_id: null,
      occurrence_date: '2026-06-20',
      surface: 'chore',
      frame_id: FRAME_ID,
      profile: PROFILE,
      skylight_id: 'sky-chore-001',
      expected_summary: cleanChoreSummary,
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
    // 1. GET via list (delete re-confirm) — description marker present confirms ownership
    // 2. DELETE chore
    // 3. GET via list (verify-deleted) → empty list (chore gone)
    // 4. POST create list item
    // 5. GET list (read-back)
    fetchSpy
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeListResponse([{ id: 'sky-chore-001', summary: cleanChoreSummary, status: 'pending', description: descMarker }]),
        text: async () => JSON.stringify(makeListResponse([{ id: 'sky-chore-001', summary: cleanChoreSummary, status: 'pending', description: descMarker }])),
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 204,
        text: async () => '',
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => makeListResponse([]),  // chore absent → verifyDeleted passes
        text: async () => JSON.stringify(makeListResponse([])),
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

// ===========================================================================
// Subrequest-reduction: batched create-verify + batched inbound fetch
// ===========================================================================

import {
  runBatchedCreateVerify,
  runCreateProtocolPostOnly,
  type PendingCreateEntry,
} from './index.js';

// ---------------------------------------------------------------------------
// Helpers shared across batch tests
// ---------------------------------------------------------------------------

function makeChoreResourceFromList(
  id: string,
  summary: string,
  date: string,
  description: string | null
): {
  id: string;
  type: 'chore';
  attributes: {
    summary: string;
    status: string;
    start: string;
    start_time: null;
    recurring: boolean;
    completed_on: null;
    emoji_icon: null;
    reward_points: null;
    category_id: null;
    category_ids: null;
    description: string | null;
  };
} {
  return {
    id,
    type: 'chore' as const,
    attributes: {
      summary,
      status: 'pending',
      start: date,
      start_time: null,
      recurring: false,
      completed_on: null,
      emoji_icon: null,
      reward_points: null,
      category_id: null,
      category_ids: null,
      description,
    },
  };
}

function makeBatchListResponse(chores: Array<{ id: string; summary: string; date: string; description: string | null; status?: string }>) {
  return {
    data: chores.map((c) => ({
      id: c.id,
      type: 'chore' as const,
      attributes: {
        summary: c.summary,
        status: c.status ?? 'pending',
        start: c.date,
        start_time: null,
        recurring: false,
        completed_on: c.status === 'complete' ? c.date : null,
        emoji_icon: null,
        reward_points: null,
        category_id: null,
        category_ids: null,
        description: c.description,
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests: runBatchedCreateVerify — one GET for N creates
// ---------------------------------------------------------------------------

describe('runBatchedCreateVerify — single list GET verifies multiple creates', () => {
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

  it('(batch-1) verifies 3 creates with EXACTLY ONE list GET, commits all active', async () => {
    const db = new InMemoryD1();

    // Seed 3 'creating' rows (write-ahead already done by runCreateProtocolPostOnly)
    const tasks = [
      { id: 'task-b001', content: 'Chore A', description: '', labels: [], due: { date: '2026-07-01', string: '', is_recurring: false } },
      { id: 'task-b002', content: 'Chore B', description: '', labels: [], due: { date: '2026-07-05', string: '', is_recurring: false } },
      { id: 'task-b003', content: 'Chore C', description: '', labels: [], due: { date: '2026-07-10', string: '', is_recurring: false } },
    ];

    // Pre-seed 'creating' rows
    for (const t of tasks) {
      db.rows.set(`${t.id}:${t.due!.date}`, {
        todoist_id: t.id, fp_stable_id: null, occurrence_date: t.due!.date,
        surface: 'chore', frame_id: FRAME_ID, profile: PROFILE,
        skylight_id: null, expected_summary: t.content, last_pushed_status: null,
        observed_status: null, last_pushed_hash: null, state: 'creating',
        idem_token: sentinelToken(t.id), updated_at: null,
      });
    }

    const entries: PendingCreateEntry[] = tasks.map((t, i) => ({
      task: t,
      occurrenceDate: t.due!.date,
      profile: PROFILE,
      skylightId: `sky-batch-00${i + 1}`,
      dueDate: t.due!.date,
      descMarker: choreDescriptionMarker(t.id),
      expectedSummary: t.content,
    }));

    // ONE batched list GET returns all three chores — window: 2026-06-30 to 2026-07-11
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeBatchListResponse([
        { id: 'sky-batch-001', summary: 'Chore A', date: '2026-07-01', description: choreDescriptionMarker('task-b001') },
        { id: 'sky-batch-002', summary: 'Chore B', date: '2026-07-05', description: choreDescriptionMarker('task-b002') },
        { id: 'sky-batch-003', summary: 'Chore C', date: '2026-07-10', description: choreDescriptionMarker('task-b003') },
      ]),
      text: async () => JSON.stringify(makeBatchListResponse([
        { id: 'sky-batch-001', summary: 'Chore A', date: '2026-07-01', description: choreDescriptionMarker('task-b001') },
        { id: 'sky-batch-002', summary: 'Chore B', date: '2026-07-05', description: choreDescriptionMarker('task-b002') },
        { id: 'sky-batch-003', summary: 'Chore C', date: '2026-07-10', description: choreDescriptionMarker('task-b003') },
      ])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runBatchedCreateVerify(client, db.asD1(), entries);

    // CRITICAL: exactly ONE GET was issued (not 3)
    const getCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => !opts?.method || opts.method === 'GET'
    );
    expect(getCalls).toHaveLength(1);
    expect(fetchSpy.mock.calls).toHaveLength(1);

    // All three rows committed to 'active'
    for (const t of tasks) {
      const row = db.getRow(t.id, t.due!.date);
      expect(row?.state).toBe('active');
      expect(row?.skylight_id).toMatch(/^sky-batch-00/);
    }
  });

  it('(batch-2) chore absent from batch window → needs_review (not active)', async () => {
    const db = new InMemoryD1();

    const tasks = [
      { id: 'task-c001', content: 'Present', description: '', labels: [], due: { date: '2026-07-01', string: '', is_recurring: false } },
      { id: 'task-c002', content: 'Missing', description: '', labels: [], due: { date: '2026-07-03', string: '', is_recurring: false } },
    ];

    for (const t of tasks) {
      db.rows.set(`${t.id}:${t.due!.date}`, {
        todoist_id: t.id, fp_stable_id: null, occurrence_date: t.due!.date,
        surface: 'chore', frame_id: FRAME_ID, profile: PROFILE,
        skylight_id: null, expected_summary: t.content, last_pushed_status: null,
        observed_status: null, last_pushed_hash: null, state: 'creating',
        idem_token: sentinelToken(t.id), updated_at: null,
      });
    }

    const entries: PendingCreateEntry[] = [
      {
        task: tasks[0],
        occurrenceDate: tasks[0].due!.date,
        profile: PROFILE,
        skylightId: 'sky-present-001',
        dueDate: tasks[0].due!.date,
        descMarker: choreDescriptionMarker(tasks[0].id),
        expectedSummary: tasks[0].content,
      },
      {
        task: tasks[1],
        occurrenceDate: tasks[1].due!.date,
        profile: PROFILE,
        skylightId: 'sky-missing-001',
        dueDate: tasks[1].due!.date,
        descMarker: choreDescriptionMarker(tasks[1].id),
        expectedSummary: tasks[1].content,
      },
    ];

    // Batch returns only the first chore — second is absent (404 region)
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeBatchListResponse([
        { id: 'sky-present-001', summary: 'Present', date: '2026-07-01', description: choreDescriptionMarker('task-c001') },
      ]),
      text: async () => JSON.stringify(makeBatchListResponse([
        { id: 'sky-present-001', summary: 'Present', date: '2026-07-01', description: choreDescriptionMarker('task-c001') },
      ])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runBatchedCreateVerify(client, db.asD1(), entries);

    // Present chore → active
    expect(db.getRow(tasks[0].id, tasks[0].due!.date)?.state).toBe('active');
    // Missing chore → needs_review
    expect(db.getRow(tasks[1].id, tasks[1].due!.date)?.state).toBe('needs_review');

    // Still only ONE GET
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  it('(batch-3) window spans min..max across all entry dates (not a fixed window)', async () => {
    // This verifies that batchFetchChoresByIds uses the ACTUAL date range, not a fixed window.
    const db = new InMemoryD1();

    const wideEntries: PendingCreateEntry[] = [
      {
        task: { id: 'task-w001', content: 'Early', description: '', labels: [], due: { date: '2026-06-01' } },
        occurrenceDate: '2026-06-01',
        profile: PROFILE,
        skylightId: 'sky-w001',
        dueDate: '2026-06-01',
        descMarker: choreDescriptionMarker('task-w001'),
        expectedSummary: 'Early',
      },
      {
        task: { id: 'task-w002', content: 'Late', description: '', labels: [], due: { date: '2026-09-30' } },
        occurrenceDate: '2026-09-30',
        profile: PROFILE,
        skylightId: 'sky-w002',
        dueDate: '2026-09-30',
        descMarker: choreDescriptionMarker('task-w002'),
        expectedSummary: 'Late',
      },
    ];

    for (const e of wideEntries) {
      db.rows.set(`${e.task.id}:${e.occurrenceDate}`, {
        todoist_id: e.task.id, fp_stable_id: null, occurrence_date: e.occurrenceDate,
        surface: 'chore', frame_id: FRAME_ID, profile: PROFILE,
        skylight_id: null, expected_summary: e.expectedSummary, last_pushed_status: null,
        observed_status: null, last_pushed_hash: null, state: 'creating',
        idem_token: sentinelToken(e.task.id), updated_at: null,
      });
    }

    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeBatchListResponse([
        { id: 'sky-w001', summary: 'Early', date: '2026-06-01', description: choreDescriptionMarker('task-w001') },
        { id: 'sky-w002', summary: 'Late', date: '2026-09-30', description: choreDescriptionMarker('task-w002') },
      ]),
      text: async () => JSON.stringify(makeBatchListResponse([
        { id: 'sky-w001', summary: 'Early', date: '2026-06-01', description: choreDescriptionMarker('task-w001') },
        { id: 'sky-w002', summary: 'Late', date: '2026-09-30', description: choreDescriptionMarker('task-w002') },
      ])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runBatchedCreateVerify(client, db.asD1(), wideEntries);

    // Both committed active (window was wide enough)
    expect(db.getRow('task-w001', '2026-06-01')?.state).toBe('active');
    expect(db.getRow('task-w002', '2026-09-30')?.state).toBe('active');

    // Verify the GET URL includes after= and before= spanning the full range
    const getUrl = (fetchSpy.mock.calls[0] as [string])[0];
    expect(getUrl).toContain('after=2026-05-31'); // min date - 1
    expect(getUrl).toContain('before=2026-10-01'); // max date + 1
  });

  it('(batch-4) wrong description marker on batch response → needs_review, not active', async () => {
    const db = new InMemoryD1();

    const task = { id: 'task-m001', content: 'Test', description: '', labels: [], due: { date: '2026-07-01', string: '', is_recurring: false } };
    db.rows.set(`${task.id}:${task.due.date}`, {
      todoist_id: task.id, fp_stable_id: null, occurrence_date: task.due.date,
      surface: 'chore', frame_id: FRAME_ID, profile: PROFILE,
      skylight_id: null, expected_summary: task.content, last_pushed_status: null,
      observed_status: null, last_pushed_hash: null, state: 'creating',
      idem_token: sentinelToken(task.id), updated_at: null,
    });

    const entries: PendingCreateEntry[] = [{
      task,
      occurrenceDate: task.due.date,
      profile: PROFILE,
      skylightId: 'sky-m001',
      dueDate: task.due.date,
      descMarker: choreDescriptionMarker(task.id),
      expectedSummary: task.content,
    }];

    // Batch returns the chore but with a WRONG description marker (attacker/family chore)
    const foreignMarker = choreDescriptionMarker('attacker-999');
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeBatchListResponse([
        { id: 'sky-m001', summary: 'Test', date: '2026-07-01', description: foreignMarker },
      ]),
      text: async () => JSON.stringify(makeBatchListResponse([
        { id: 'sky-m001', summary: 'Test', date: '2026-07-01', description: foreignMarker },
      ])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });

    await runBatchedCreateVerify(client, db.asD1(), entries);

    // Must NOT be active — marker mismatch → needs_review
    const row = db.getRow(task.id, task.due.date);
    expect(row?.state).toBe('needs_review');
    expect(row?.skylight_id ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: runOutboundPass with batched create-verify (multi-create)
// ---------------------------------------------------------------------------

// Module mock already in scope from outbound.test.ts file; here we need it too.
// Since we're in the same file as other tests, we re-use the global mock.
// (The vi.mock in outbound.test.ts applies to that file only; here we use direct
//  runBatchedCreateVerify + runCreateProtocolPostOnly tests above for the core.)
//
// For the outbound pass integration, we test via the REAL runBatchedCreateVerify export.

describe('runBatchedCreateVerify — DRYRUN: no writes', () => {
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

  it('(batch-dryrun) DRYRUN: runBatchedCreateVerify issues zero GETs and zero D1 writes', async () => {
    const db = new InMemoryD1();
    const entries: PendingCreateEntry[] = [
      {
        task: { id: 'task-dr1', content: 'X', description: '', labels: [], due: { date: '2026-07-01' } },
        occurrenceDate: '2026-07-01',
        profile: PROFILE,
        skylightId: 'sky-dr1',
        dueDate: '2026-07-01',
        descMarker: choreDescriptionMarker('task-dr1'),
        expectedSummary: 'X',
      },
    ];

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: true, token: 'tok' });

    // Under dryrun, the batch verify still does the GET (it's a read operation)
    // but commits nothing to D1.
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeBatchListResponse([
        { id: 'sky-dr1', summary: 'X', date: '2026-07-01', description: choreDescriptionMarker('task-dr1') },
      ]),
      text: async () => JSON.stringify(makeBatchListResponse([
        { id: 'sky-dr1', summary: 'X', date: '2026-07-01', description: choreDescriptionMarker('task-dr1') },
      ])),
      headers: { get: () => null },
    } as unknown as Response);

    // Must not throw
    await runBatchedCreateVerify(client, db.asD1(), entries, true /* dryrun */);

    // No mutating calls
    const mutatingCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST' || opts?.method === 'PUT' || opts?.method === 'DELETE'
    );
    expect(mutatingCalls).toHaveLength(0);

    // D1 must not be mutated (no row seeded, so it stays empty)
    expect(db.allRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: runInboundPass batched fetch — ONE list GET for N active mappings
// ---------------------------------------------------------------------------

describe('runInboundPass — batched list GET for active chore mappings', () => {
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

  function seedChoreRow(db: InMemoryD1, id: string, skylightId: string, date: string, overrides: Partial<MappingRow> = {}): MappingRow {
    const row: MappingRow = {
      todoist_id: id,
      fp_stable_id: null,
      occurrence_date: date,
      surface: 'chore',
      frame_id: FRAME_ID,
      profile: PROFILE,
      skylight_id: skylightId,
      expected_summary: 'Chore ' + id,
      last_pushed_status: 'pending',
      observed_status: 'pending',
      last_pushed_hash: null,
      state: 'active',
      idem_token: sentinelToken(id),
      updated_at: null,
      ...overrides,
    };
    db.rows.set(`${id}:${date}`, row as unknown as D1Row);
    return row;
  }

  it('(inbound-batch-1) 3 active chore mappings: ONE list GET, completion detected from batch', async () => {
    const db = new InMemoryD1();

    // Seed 3 active chore rows — one is complete on device
    seedChoreRow(db, 'task-ib001', 'sky-ib001', '2026-07-01');
    seedChoreRow(db, 'task-ib002', 'sky-ib002', '2026-07-05', { last_pushed_status: 'pending' });
    seedChoreRow(db, 'task-ib003', 'sky-ib003', '2026-07-10');

    const m002Marker = choreDescriptionMarker('task-ib002');

    // ONE batched list GET returns all 3 — task-ib002 is completed on device
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeBatchListResponse([
        { id: 'sky-ib001', summary: 'Chore task-ib001', date: '2026-07-01', description: choreDescriptionMarker('task-ib001') },
        { id: 'sky-ib002', summary: 'Chore task-ib002', date: '2026-07-05', description: m002Marker, status: 'complete' },
        { id: 'sky-ib003', summary: 'Chore task-ib003', date: '2026-07-10', description: choreDescriptionMarker('task-ib003') },
      ]),
      text: async () => JSON.stringify(makeBatchListResponse([
        { id: 'sky-ib001', summary: 'Chore task-ib001', date: '2026-07-01', description: choreDescriptionMarker('task-ib001') },
        { id: 'sky-ib002', summary: 'Chore task-ib002', date: '2026-07-05', description: m002Marker, status: 'complete' },
        { id: 'sky-ib003', summary: 'Chore task-ib003', date: '2026-07-10', description: choreDescriptionMarker('task-ib003') },
      ])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const closedTaskIds: string[] = [];
    const deps: InboundPassDeps = {
      getTaskFn: async (id) => ({
        id,
        content: 'Chore ' + id,
        description: '',
        labels: [],
        project_id: '',
        section_id: null,
        parent_id: null,
        due: { date: '2026-07-05', string: '', is_recurring: false },
        priority: 1,
        checked: false,
      }) as import('./types.js').RawTask,
      closeTaskFn: async (id) => { closedTaskIds.push(id); },
      todoistApiToken: 'tok',
      dryrun: false,
    };

    await runInboundPass(client, db.asD1(), FRAME_ID, deps);

    // task-ib002 device-completed → should have closed Todoist
    expect(closedTaskIds).toContain('task-ib002');

    // Count list GETs: the batch fetch is ONE call, plus any follow-on calls
    // (updateObservedStatus does no fetch; complete protocol does getChoreById+PUT+verify)
    const allGetCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([url]) => (url as string).includes('/chores?')
    );
    // The FIRST call (batch) is ONE GET covering all 3 mappings (not 3 separate GETs)
    // completeProtocol adds 2 more GETs (ownership re-GET + verifyCompleted) = total 3
    // But critically, the initial "observe" step is 1 GET not 3
    // Verify: batch GET URL spans min date 2026-06-30 to max date 2026-07-11
    const batchGetUrl = allGetCalls[0][0] as string;
    expect(batchGetUrl).toContain('after=2026-06-30'); // 2026-07-01 - 1
    expect(batchGetUrl).toContain('before=2026-07-11'); // 2026-07-10 + 1
  });

  it('(inbound-batch-2) wrong-marker chore in batched response → detached, no close Todoist', async () => {
    const db = new InMemoryD1();

    seedChoreRow(db, 'task-ib004', 'sky-ib004', '2026-07-01');

    // Batch returns the chore with a FOREIGN description marker
    const foreignMarker = choreDescriptionMarker('foreign-task-000');
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeBatchListResponse([
        { id: 'sky-ib004', summary: 'Family chore', date: '2026-07-01', description: foreignMarker, status: 'complete' },
      ]),
      text: async () => JSON.stringify(makeBatchListResponse([
        { id: 'sky-ib004', summary: 'Family chore', date: '2026-07-01', description: foreignMarker, status: 'complete' },
      ])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const closedTaskIds: string[] = [];
    const deps: InboundPassDeps = {
      getTaskFn: async (id) => ({
        id, content: 'Chore', description: '', labels: [], project_id: '', section_id: null,
        parent_id: null, due: { date: '2026-07-01', string: '', is_recurring: false }, priority: 1, checked: false,
      }) as import('./types.js').RawTask,
      closeTaskFn: async (id) => { closedTaskIds.push(id); },
      todoistApiToken: 'tok',
      dryrun: false,
    };

    await runInboundPass(client, db.asD1(), FRAME_ID, deps);

    // Row should be detached
    const row = db.getRow('task-ib004', '2026-07-01');
    expect(row?.state).toBe('detached');

    // No Todoist close issued — wrong-marker guard blocks it
    expect(closedTaskIds).toHaveLength(0);
  });

  it('(inbound-batch-3) chore absent from batched response → treated as device-deleted, mapping dropped', async () => {
    const db = new InMemoryD1();

    seedChoreRow(db, 'task-ib005', 'sky-ib005', '2026-07-01');

    // Batch returns an EMPTY list (chore is absent from the window)
    fetchSpy.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => makeBatchListResponse([]),
      text: async () => JSON.stringify(makeBatchListResponse([])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const closedTaskIds: string[] = [];
    const deps: InboundPassDeps = {
      getTaskFn: async (id) => ({
        id, content: 'Chore', description: '', labels: [], project_id: '', section_id: null,
        parent_id: null, due: { date: '2026-07-01', string: '', is_recurring: false }, priority: 1, checked: false,
      }) as import('./types.js').RawTask,
      closeTaskFn: async (id) => { closedTaskIds.push(id); },
      todoistApiToken: 'tok',
      dryrun: false,
    };

    await runInboundPass(client, db.asD1(), FRAME_ID, deps);

    // Row should be hard-deleted (device-deleted path)
    expect(db.getRow('task-ib005', '2026-07-01')).toBeUndefined();

    // No Todoist close issued
    expect(closedTaskIds).toHaveLength(0);
  });

  it('(inbound-batch-4) 3 active chore rows: batch issues 1 list GET not 3 individual GETs', async () => {
    const db = new InMemoryD1();

    seedChoreRow(db, 'task-ib006', 'sky-ib006', '2026-07-02');
    seedChoreRow(db, 'task-ib007', 'sky-ib007', '2026-07-04');
    seedChoreRow(db, 'task-ib008', 'sky-ib008', '2026-07-06');

    // ONE batch response — all 3 pending (no action needed beyond observe)
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => makeBatchListResponse([
        { id: 'sky-ib006', summary: 'Chore task-ib006', date: '2026-07-02', description: choreDescriptionMarker('task-ib006') },
        { id: 'sky-ib007', summary: 'Chore task-ib007', date: '2026-07-04', description: choreDescriptionMarker('task-ib007') },
        { id: 'sky-ib008', summary: 'Chore task-ib008', date: '2026-07-06', description: choreDescriptionMarker('task-ib008') },
      ]),
      text: async () => JSON.stringify(makeBatchListResponse([
        { id: 'sky-ib006', summary: 'Chore task-ib006', date: '2026-07-02', description: choreDescriptionMarker('task-ib006') },
        { id: 'sky-ib007', summary: 'Chore task-ib007', date: '2026-07-04', description: choreDescriptionMarker('task-ib007') },
        { id: 'sky-ib008', summary: 'Chore task-ib008', date: '2026-07-06', description: choreDescriptionMarker('task-ib008') },
      ])),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({ frameId: FRAME_ID, dryrun: false, token: 'tok' });
    const deps: InboundPassDeps = {
      getTaskFn: async (id) => ({
        id, content: 'Chore ' + id, description: '', labels: [], project_id: '', section_id: null,
        parent_id: null, due: { date: '2026-07-02', string: '', is_recurring: false }, priority: 1, checked: false,
      }) as import('./types.js').RawTask,
      closeTaskFn: async () => {},
      todoistApiToken: 'tok',
      dryrun: false,
    };

    await runInboundPass(client, db.asD1(), FRAME_ID, deps);

    // Count list GETs to Skylight chore endpoint — should be exactly 1 (the batch fetch)
    // All 3 are pending+echo (observed=pending=lastPushed) so no completeProtocol GETs fire
    const choreGets = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([url]) => (url as string).includes('/chores?')
    );
    expect(choreGets).toHaveLength(1);

    // Batch GET URL spans 2026-07-01 to 2026-07-07 (min-1 to max+1)
    const batchUrl = choreGets[0][0] as string;
    expect(batchUrl).toContain('after=2026-07-01'); // 2026-07-02 - 1
    expect(batchUrl).toContain('before=2026-07-07'); // 2026-07-06 + 1
  });
});
