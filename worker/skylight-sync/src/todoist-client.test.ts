/**
 * Tests for todoist-client.ts — focussed on fetchDeckTasks efficiency fix.
 *
 * KEY INVARIANTS:
 *  (TC-1) fetchDeckTasks issues a SMALL CONSTANT number of Todoist GETs (~2-3)
 *         for a multi-deck-project fixture, NOT one per project.
 *  (TC-2) The returned task set is IDENTICAL to what the per-project approach
 *         would return: same task ids, fields, profile mapping semantics, and
 *         FP:: metadata preserved on the task objects. Non-deck tasks filtered out.
 *  (TC-3) The onFetch hook increments exactly once per actual HTTP GET (including
 *         each pagination page).
 *  (TC-4) Carrier tasks (FP-item/FP-config/FP-charter labels) are excluded.
 *  (TC-5) Tasks in non-deck projects are filtered out in-memory.
 *  (TC-6) A deck project with zero tasks yields no results (correct, not an error).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RawProject, RawTask, PagedResponse } from './types.js';
import { fetchDeckTasks, fetchAllTasks } from './todoist-client.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeProject(id: string, name: string, parentId: string | null, childOrder = 0): RawProject {
  return { id, name, parent_id: parentId, child_order: childOrder };
}

function makeTask(id: string, projectId: string, content: string, labels: string[] = [], description = ''): RawTask {
  return {
    id,
    content,
    description,
    labels,
    project_id: projectId,
    section_id: null,
    parent_id: null,
    due: { date: '2026-06-25', string: 'Jun 25', is_recurring: false },
    priority: 1,
    checked: false,
  };
}

// Build a paged response (single page, no cursor) for GET /projects
function projectsPage(projects: RawProject[]): PagedResponse<RawProject> {
  return { results: projects };
}

// Build a paged response (single page, no cursor) for GET /tasks
function tasksPage(tasks: RawTask[]): PagedResponse<RawTask> {
  return { results: tasks };
}

// ---------------------------------------------------------------------------
// Fixture: multi-deck-project scenario
//
// Project tree:
//   "My Fair Play Cards"  (root, parent_id=null)   → kyle's deckParent
//     ├─ "Grocery Shopping"   (deck card 1, id=p-deck-1)
//     ├─ "Lawn Care"          (deck card 2, id=p-deck-2)
//     └─ "Dinner Plan"        (deck card 3, id=p-deck-3)
//   "Amy's Fair Play Cards" (root, parent_id=null) → amy's deckParent
//     └─ "Laundry"            (amy deck card, id=p-deck-amy)
//   "Inbox"                 (unrelated project, id=p-inbox)
//
// Tasks:
//   task-1 → p-deck-1  (kyle deck)
//   task-2 → p-deck-2  (kyle deck)
//   task-3 → p-deck-3  (kyle deck)
//   task-4 → p-deck-amy (amy deck — not kyle's)
//   task-5 → p-inbox   (not deck at all)
//   task-carrier → p-deck-1 with label FP-item (carrier, excluded)
//   task-fp → p-deck-2 with FP:: metadata in description (preserved)
// ---------------------------------------------------------------------------

const KYLE_PARENT_ID = 'p-kyle-parent';
const AMY_PARENT_ID = 'p-amy-parent';
const DECK_1_ID = 'p-deck-1';
const DECK_2_ID = 'p-deck-2';
const DECK_3_ID = 'p-deck-3';
const AMY_DECK_ID = 'p-deck-amy';
const INBOX_ID = 'p-inbox';

const ALL_PROJECTS: RawProject[] = [
  makeProject(KYLE_PARENT_ID, 'My Fair Play Cards', null),
  makeProject(AMY_PARENT_ID, "Amy's Fair Play Cards", null),
  makeProject(DECK_1_ID, 'Grocery Shopping', KYLE_PARENT_ID, 0),
  makeProject(DECK_2_ID, 'Lawn Care', KYLE_PARENT_ID, 1),
  makeProject(DECK_3_ID, 'Dinner Plan', KYLE_PARENT_ID, 2),
  makeProject(AMY_DECK_ID, 'Laundry', AMY_PARENT_ID, 0),
  makeProject(INBOX_ID, 'Inbox', null),
];

const FP_DESC = 'FP::id=abc123\nFP::profile=kyle';

const ALL_TASKS: RawTask[] = [
  makeTask('task-1', DECK_1_ID, 'Buy groceries'),
  makeTask('task-2', DECK_2_ID, 'Mow the lawn'),
  makeTask('task-3', DECK_3_ID, 'Cook dinner'),
  makeTask('task-4', AMY_DECK_ID, "Amy's laundry"),
  makeTask('task-5', INBOX_ID, 'Random inbox task'),
  makeTask('task-carrier', DECK_1_ID, 'Carrier task', ['FP-item']),
  makeTask('task-fp', DECK_2_ID, 'Task with FP metadata', [], FP_DESC),
];

// ---------------------------------------------------------------------------
// Mock globalThis.fetch to intercept all calls
// ---------------------------------------------------------------------------

function buildFetchMock(opts: {
  projects: RawProject[];
  tasks: RawTask[];
}) {
  return vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;

    if (urlStr.includes('/api/v1/projects')) {
      return {
        ok: true,
        status: 200,
        json: async () => projectsPage(opts.projects),
        headers: { get: () => null },
      } as unknown as Response;
    }

    if (urlStr.includes('/api/v1/tasks')) {
      return {
        ok: true,
        status: 200,
        json: async () => tasksPage(opts.tasks),
        headers: { get: () => null },
      } as unknown as Response;
    }

    throw new Error(`Unexpected fetch url: ${urlStr}`);
  });
}

// ---------------------------------------------------------------------------
// (TC-1) fetchDeckTasks issues a small constant number of GETs
// ---------------------------------------------------------------------------

describe('fetchDeckTasks — constant API call count (TC-1)', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('makes exactly 2 HTTP GETs for a 3-deck-project fixture (projects page + tasks page)', async () => {
    fetchSpy = buildFetchMock({ projects: ALL_PROJECTS, tasks: ALL_TASKS });
    globalThis.fetch = fetchSpy as typeof globalThis.fetch;

    await fetchDeckTasks('kyle', 'tok-test');

    // Must be exactly 2 calls: 1 GET /projects + 1 GET /tasks
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const urls = (fetchSpy.mock.calls as [string, unknown][]).map(([u]) => u as string);
    expect(urls.some((u) => u.includes('/api/v1/projects'))).toBe(true);
    expect(urls.some((u) => u.includes('/api/v1/tasks'))).toBe(true);

    // CRITICAL: must NOT make per-project calls (no project_id filter on tasks)
    const perProjectCalls = urls.filter((u) => u.includes('project_id='));
    expect(perProjectCalls).toHaveLength(0);
  });

  it('does not increase call count as deck projects scale (3-project deck = same 2 calls)', async () => {
    // If the old per-project approach were used, 3 deck projects = 4 calls (1 projects + 3 tasks)
    // New approach: always 2 calls regardless
    fetchSpy = buildFetchMock({ projects: ALL_PROJECTS, tasks: ALL_TASKS });
    globalThis.fetch = fetchSpy as typeof globalThis.fetch;

    await fetchDeckTasks('kyle', 'tok-test');

    // Strictly 2 — not 4 (per-project) and not more
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('handles amy profile with 1 deck project in same 2 calls', async () => {
    fetchSpy = buildFetchMock({ projects: ALL_PROJECTS, tasks: ALL_TASKS });
    globalThis.fetch = fetchSpy as typeof globalThis.fetch;

    await fetchDeckTasks('amy', 'tok-test');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = (fetchSpy.mock.calls as [string, unknown][]).map(([u]) => u as string);
    const perProjectCalls = urls.filter((u) => u.includes('project_id='));
    expect(perProjectCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (TC-2) Returned task set is identical to per-project result for same Todoist state
// ---------------------------------------------------------------------------

describe('fetchDeckTasks — correct task set (TC-2)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns exactly the deck tasks for kyle (task-1, task-2, task-3, task-fp) — excludes non-deck and carriers', async () => {
    globalThis.fetch = buildFetchMock({ projects: ALL_PROJECTS, tasks: ALL_TASKS }) as typeof globalThis.fetch;

    const result = await fetchDeckTasks('kyle', 'tok-test');

    const ids = result.map((t) => t.id).sort();
    // task-1 (deck-1), task-2 (deck-2), task-3 (deck-3), task-fp (deck-2)
    expect(ids).toEqual(['task-1', 'task-2', 'task-3', 'task-fp'].sort());

    // task-4 (amy deck), task-5 (inbox), task-carrier (FP-item label) must NOT appear
    expect(ids).not.toContain('task-4');
    expect(ids).not.toContain('task-5');
    expect(ids).not.toContain('task-carrier');
  });

  it('returns exactly the deck tasks for amy (task-4 only)', async () => {
    globalThis.fetch = buildFetchMock({ projects: ALL_PROJECTS, tasks: ALL_TASKS }) as typeof globalThis.fetch;

    const result = await fetchDeckTasks('amy', 'tok-test');

    const ids = result.map((t) => t.id);
    expect(ids).toEqual(['task-4']);
  });

  it('preserves all task fields including description (FP:: metadata)', async () => {
    globalThis.fetch = buildFetchMock({ projects: ALL_PROJECTS, tasks: ALL_TASKS }) as typeof globalThis.fetch;

    const result = await fetchDeckTasks('kyle', 'tok-test');
    const fpTask = result.find((t) => t.id === 'task-fp');

    expect(fpTask).toBeDefined();
    expect(fpTask!.description).toBe(FP_DESC);
    expect(fpTask!.content).toBe('Task with FP metadata');
    expect(fpTask!.project_id).toBe(DECK_2_ID);
    expect(fpTask!.labels).toEqual([]);
    expect(fpTask!.due?.date).toBe('2026-06-25');
  });

  it('returns empty array when deck has zero tasks (deck project exists but no tasks in it)', async () => {
    // All tasks are in non-deck projects
    const noKyleTasks = ALL_TASKS.filter((t) => t.project_id !== DECK_1_ID && t.project_id !== DECK_2_ID && t.project_id !== DECK_3_ID);
    globalThis.fetch = buildFetchMock({ projects: ALL_PROJECTS, tasks: noKyleTasks }) as typeof globalThis.fetch;

    const result = await fetchDeckTasks('kyle', 'tok-test');
    expect(result).toHaveLength(0);
  });

  it('(TC-5) tasks in non-deck projects are filtered out in-memory', async () => {
    globalThis.fetch = buildFetchMock({ projects: ALL_PROJECTS, tasks: ALL_TASKS }) as typeof globalThis.fetch;

    const result = await fetchDeckTasks('kyle', 'tok-test');
    // inbox task must not appear
    expect(result.find((t) => t.id === 'task-5')).toBeUndefined();
  });

  it('(TC-4) carrier tasks with FP-item/FP-config/FP-charter labels are excluded', async () => {
    const tasksWithCarriers: RawTask[] = [
      ...ALL_TASKS,
      makeTask('task-config', DECK_1_ID, 'Config carrier', ['FP-config']),
      makeTask('task-charter', DECK_2_ID, 'Charter carrier', ['FP-charter']),
    ];
    globalThis.fetch = buildFetchMock({ projects: ALL_PROJECTS, tasks: tasksWithCarriers }) as typeof globalThis.fetch;

    const result = await fetchDeckTasks('kyle', 'tok-test');
    const ids = result.map((t) => t.id);
    expect(ids).not.toContain('task-carrier');
    expect(ids).not.toContain('task-config');
    expect(ids).not.toContain('task-charter');
  });
});

// ---------------------------------------------------------------------------
// (TC-3) onFetch hook increments once per actual HTTP GET
// ---------------------------------------------------------------------------

describe('fetchDeckTasks — onFetch hook counts precisely (TC-3)', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('onFetch called exactly once per HTTP GET (2 calls total for projects + tasks pages)', async () => {
    globalThis.fetch = buildFetchMock({ projects: ALL_PROJECTS, tasks: ALL_TASKS }) as typeof globalThis.fetch;

    let hookCount = 0;
    const onFetch = () => { hookCount++; };

    await fetchDeckTasks('kyle', 'tok-test', onFetch);

    // 1 GET /projects + 1 GET /tasks = 2 onFetch increments
    expect(hookCount).toBe(2);
  });

  it('onFetch called for each pagination page (projects page 1 + tasks page 1 + tasks page 2 = 3)', async () => {
    // Simulate 2-page tasks response
    const PAGE_1_TASKS = ALL_TASKS.slice(0, 3);
    const PAGE_2_TASKS = ALL_TASKS.slice(3);
    const CURSOR = 'cursor-page-2';

    let callIndex = 0;
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : (url as Request).url;
      callIndex++;

      if (urlStr.includes('/api/v1/projects')) {
        return {
          ok: true, status: 200,
          json: async () => ({ results: ALL_PROJECTS }),
          headers: { get: () => null },
        } as unknown as Response;
      }

      if (urlStr.includes('/api/v1/tasks')) {
        if (urlStr.includes(`cursor=${CURSOR}`)) {
          // Second page — no next cursor
          return {
            ok: true, status: 200,
            json: async () => ({ results: PAGE_2_TASKS }),
            headers: { get: () => null },
          } as unknown as Response;
        }
        // First page — has a next cursor
        return {
          ok: true, status: 200,
          json: async () => ({ results: PAGE_1_TASKS, next_cursor: CURSOR }),
          headers: { get: () => null },
        } as unknown as Response;
      }

      throw new Error(`Unexpected url: ${urlStr}`);
    }) as typeof globalThis.fetch;

    let hookCount = 0;
    const onFetch = () => { hookCount++; };

    await fetchDeckTasks('kyle', 'tok-test', onFetch);

    // 1 GET /projects + 2 GET /tasks (page1 + page2) = 3 hooks
    expect(hookCount).toBe(3);
    expect(callIndex).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// fetchAllTasks — exported for completeness, verify basic behavior
// ---------------------------------------------------------------------------

describe('fetchAllTasks — fetches all tasks without project filter', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('calls GET /api/v1/tasks without project_id parameter', async () => {
    const fetchSpy = buildFetchMock({ projects: [], tasks: ALL_TASKS });
    globalThis.fetch = fetchSpy as typeof globalThis.fetch;

    const result = await fetchAllTasks('tok-test');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = (fetchSpy.mock.calls[0] as unknown[])[0] as string;
    expect(url).toContain('/api/v1/tasks');
    expect(url).not.toContain('project_id');
    expect(result).toHaveLength(ALL_TASKS.length);
  });
});
