/**
 * Regression tests for getChoreById date-window behavior.
 *
 * Problem: previous tests mocked fetch unconditionally (returning the chore
 * regardless of the request URL), so they would NOT catch a regression that:
 *   - narrows the window (e.g. ±0 days instead of ±1)
 *   - passes the wrong date
 *   - drops include_up_for_grabs or include_late
 *   - silently reverts to the old by-id GET (/chores/{id} with no query)
 *
 * This test file uses a URL-aware fetch mock that PARSES the request URL's
 * query params and only returns the chore when its start date falls within
 * [after, before]. This means the positive tests are only meaningful if the
 * window is actually correct.
 *
 * Sabotage-check (performed during development):
 *   Narrowing the window to ±0 days in isoDateOffset calls inside getChoreById
 *   (after=before=date) causes the boundary tests (start=date±1) to FAIL,
 *   confirming the mock is not a no-op. Restoring ±1 makes all tests green.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SkylightClient, SKYLIGHT_BASE } from './skylight-client.js';
import type { ChoreResource } from './types.js';

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function makeChore(id: string, start: string): ChoreResource {
  return {
    id,
    type: 'chore',
    attributes: {
      summary: `Test chore ${id}`,
      status: 'pending',
      start,
      start_time: null,
      recurring: false,
      completed_on: null,
      emoji_icon: null,
      reward_points: null,
      category_id: null,
      category_ids: null,
      description: null,
    },
  };
}

/**
 * Build a URL-aware fetch mock that:
 *   - Only responds to GET /api/frames/{frameId}/chores?...
 *   - Parses `after` and `before` query params from the URL
 *   - Returns the chore in data[] only if chore.start falls within [after, before]
 *   - Returns an empty data[] otherwise
 *   - Records every request URL for assertions
 */
function makeWindowAwareFetchMock(frameId: string, chore: ChoreResource) {
  const calls: string[] = [];

  const mockFetch = vi.fn(async (url: string | URL | Request, _opts?: RequestInit) => {
    const urlStr = url instanceof Request ? url.url : String(url);
    calls.push(urlStr);

    const parsed = new URL(urlStr);
    const after = parsed.searchParams.get('after');
    const before = parsed.searchParams.get('before');

    let dataArray: ChoreResource[] = [];

    if (after !== null && before !== null && chore.attributes.start !== null) {
      const choreStart = chore.attributes.start;
      // Include chore only when its start date falls within [after, before] (inclusive)
      if (choreStart >= after && choreStart <= before) {
        dataArray = [chore];
      }
    }

    const body = { data: dataArray };
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    } as unknown as Response;
  });

  return { mockFetch, calls };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('getChoreById — date-window read-back regression', () => {
  const FRAME_ID = 'frame-99';
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function makeClient() {
    return new SkylightClient({
      frameId: FRAME_ID,
      dryrun: true, // reads are always allowed regardless of dryrun
      token: 'fake-token',
    });
  }

  // ── 1. Window covers own date ────────────────────────────────────────────

  it('returns the chore when chore.start matches the queried date exactly', async () => {
    const chore = makeChore('chore-x', '2026-06-17');
    const { mockFetch } = makeWindowAwareFetchMock(FRAME_ID, chore);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = makeClient();
    const result = await client.getChoreById('chore-x', '2026-06-17');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('chore-x');
  });

  // ── 2a. Boundary: chore.start = date+1 ──────────────────────────────────

  it('returns the chore when chore.start is one day after the queried date (±1d tolerance)', async () => {
    // chore starts 2026-06-18, queried date is 2026-06-17
    // The window should be [2026-06-16, 2026-06-18] → covers 2026-06-18
    const chore = makeChore('chore-x', '2026-06-18');
    const { mockFetch } = makeWindowAwareFetchMock(FRAME_ID, chore);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = makeClient();
    const result = await client.getChoreById('chore-x', '2026-06-17');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('chore-x');
  });

  // ── 2b. Boundary: chore.start = date-1 ──────────────────────────────────

  it('returns the chore when chore.start is one day before the queried date (±1d tolerance)', async () => {
    // chore starts 2026-06-16, queried date is 2026-06-17
    // The window should be [2026-06-16, 2026-06-18] → covers 2026-06-16
    const chore = makeChore('chore-x', '2026-06-16');
    const { mockFetch } = makeWindowAwareFetchMock(FRAME_ID, chore);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = makeClient();
    const result = await client.getChoreById('chore-x', '2026-06-17');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('chore-x');
  });

  // ── 3. Request URL assertions ────────────────────────────────────────────

  it('requests the LIST route (/chores?...) not the by-id route (/chores/{id})', async () => {
    const chore = makeChore('chore-x', '2026-06-17');
    const { mockFetch, calls } = makeWindowAwareFetchMock(FRAME_ID, chore);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = makeClient();
    await client.getChoreById('chore-x', '2026-06-17');

    expect(calls).toHaveLength(1);
    const url = calls[0];

    // Must be the list route (path ends in /chores?... not /chores/chore-x)
    expect(url).toContain(`/api/frames/${FRAME_ID}/chores`);
    // Must NOT be the by-id route
    expect(url).not.toMatch(/\/chores\/chore-x($|\?)/);

    const parsed = new URL(url);
    // Must contain expected base
    expect(parsed.origin).toBe(SKYLIGHT_BASE);
    // Must have query params (not a bare path)
    expect(parsed.search.length).toBeGreaterThan(0);
  });

  it('request includes include_up_for_grabs, include_late, and filter=linked_to_profile', async () => {
    const chore = makeChore('chore-x', '2026-06-17');
    const { mockFetch, calls } = makeWindowAwareFetchMock(FRAME_ID, chore);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = makeClient();
    await client.getChoreById('chore-x', '2026-06-17');

    expect(calls).toHaveLength(1);
    const parsed = new URL(calls[0]);

    expect(parsed.searchParams.get('include_up_for_grabs')).toBe('true');
    expect(parsed.searchParams.get('include_late')).toBe('true');
    // REQUIRED: profile-assigned chores only appear with this filter (confirmed
    // live: 18/18 with it, 1/18 without). Guards against re-dropping it.
    expect(parsed.searchParams.get('filter')).toBe('linked_to_profile');
  });

  it('request after param is date-1 and before param is date+1', async () => {
    const chore = makeChore('chore-x', '2026-06-17');
    const { mockFetch, calls } = makeWindowAwareFetchMock(FRAME_ID, chore);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = makeClient();
    await client.getChoreById('chore-x', '2026-06-17');

    const parsed = new URL(calls[0]);
    expect(parsed.searchParams.get('after')).toBe('2026-06-16');
    expect(parsed.searchParams.get('before')).toBe('2026-06-18');
  });

  // ── 4. Negative: chore outside window → returns null ────────────────────

  it('returns null when the chore.start is far outside the window (mock keys on window)', async () => {
    // chore starts 2026-08-01, queried date is 2026-06-17
    // Window: [2026-06-16, 2026-06-18] — 2026-08-01 is way outside → empty list
    const chore = makeChore('chore-x', '2026-08-01');
    const { mockFetch } = makeWindowAwareFetchMock(FRAME_ID, chore);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = makeClient();
    const result = await client.getChoreById('chore-x', '2026-06-17');
    expect(result).toBeNull();
  });

  it('returns null when the id is not in the list even if the window matches', async () => {
    // chore-x is in the window but we look up chore-y
    const chore = makeChore('chore-x', '2026-06-17');
    const { mockFetch } = makeWindowAwareFetchMock(FRAME_ID, chore);
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const client = makeClient();
    const result = await client.getChoreById('chore-y', '2026-06-17');
    expect(result).toBeNull();
  });
});
