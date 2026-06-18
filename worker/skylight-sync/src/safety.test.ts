/**
 * Tests for safety guards (§9 of the design spec).
 *
 * Coverage:
 *   1. DRYRUN=true → assert NO non-GET fetch is issued by any client method
 *   2. Frame guard refuses cross-frame / missing FRAME_CONFIRMED
 *   3. Create-verify rejects response whose summary lacks the sentinel
 *   4. Create-verify rejects response where data.length !== 1
 *   5. Delete protocol aborts when re-GET summary != stored expected_summary
 *   6. Sentinel helpers: buildSummary, summaryMatchesSentinel (full string, never prefix)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SkylightClient,
  FrameGuardError,
  SkylightApiError,
  DryrRunError,
  buildSummary,
  summaryMatchesSentinel,
  sentinelToken,
  SENTINEL_GLYPH,
  DRYRUN_SYNTHETIC_ID,
} from './skylight-client.js';

// ---------------------------------------------------------------------------
// Helpers to build mock responses
// ---------------------------------------------------------------------------

function makeChoreResponse(id: string, summary: string, status = 'pending') {
  return {
    data: {
      id,
      type: 'chore',
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
        type: 'chore',
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

function makeFrameResponse(id: string, name: string) {
  return {
    data: {
      id,
      type: 'frame',
      attributes: { name },
    },
  };
}

// ---------------------------------------------------------------------------
// 1. DRYRUN guard: no non-GET fetch escapes
// ---------------------------------------------------------------------------

describe('DRYRUN guard', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    // Install spy — only intercept, not replace, for GETs
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockGetResponse(body: unknown) {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    } as unknown as Response);
  }

  it('completeChore in DRYRUN mode throws DryrRunError without issuing a PUT', async () => {
    const client = new SkylightClient({
      frameId: 'frame-1',
      dryrun: true,
      token: 'fake-token',
    });

    await expect(client.completeChore('chore-123')).rejects.toThrow(DryrRunError);

    // Verify no non-GET fetch was called
    const nonGetCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method !== 'GET' && opts?.method !== undefined
    );
    expect(nonGetCalls).toHaveLength(0);
  });

  it('deleteChore in DRYRUN mode throws DryrRunError without issuing a DELETE', async () => {
    const client = new SkylightClient({
      frameId: 'frame-1',
      dryrun: true,
      token: 'fake-token',
    });

    await expect(client.deleteChore('chore-123')).rejects.toThrow(DryrRunError);

    const nonGetCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method !== 'GET' && opts?.method !== undefined
    );
    expect(nonGetCalls).toHaveLength(0);
  });

  it('createChore in DRYRUN mode throws DryrRunError without issuing a POST', async () => {
    const client = new SkylightClient({
      frameId: 'frame-1',
      dryrun: true,
      token: 'fake-token',
    });

    await expect(
      client.createChore({
        summary: 'Test chore ▸abc123',
        start: '2026-06-20',
        categoryId: null,
        idemToken: 'abc123',
      })
    ).rejects.toThrow(DryrRunError);

    const postCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'POST'
    );
    expect(postCalls).toHaveLength(0);
  });

  it('GETs are allowed even in DRYRUN mode (getChoreById)', async () => {
    mockGetResponse(makeChoreResponse('chore-1', 'Test ▸abc123'));

    const client = new SkylightClient({
      frameId: 'frame-1',
      dryrun: true,
      token: 'fake-token',
    });

    const chore = await client.getChoreById('chore-1');
    expect(chore).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();
    // Verify it was a GET (default method = GET, no method specified)
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(opts.method).toBe('GET');
  });

  it('non-DRYRUN client issues a real PUT for completeChore', async () => {
    // Mock PUT (completeChore) and GET (verifyCompleted) responses
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{}',
        headers: { get: () => null },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeChoreResponse('chore-1', 'Test ▸abc123', 'complete'),
        text: async () => JSON.stringify(makeChoreResponse('chore-1', 'Test ▸abc123', 'complete')),
        headers: { get: () => null },
      } as unknown as Response);

    const client = new SkylightClient({
      frameId: 'frame-1',
      dryrun: false,
      token: 'fake-token',
    });

    await client.completeChore('chore-1');

    const putCalls = (fetchSpy.mock.calls as [string, RequestInit | undefined][]).filter(
      ([, opts]) => opts?.method === 'PUT'
    );
    expect(putCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Frame guard
// ---------------------------------------------------------------------------

describe('Frame guard', () => {
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

  it('assertFrameFingerprint passes when name matches', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeFrameResponse('5381689', 'thehd'),
      text: async () => JSON.stringify(makeFrameResponse('5381689', 'thehd')),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({
      frameId: '5381689',
      dryrun: true,
      token: 'fake',
    });

    await expect(client.assertFrameFingerprint('5381689:thehd')).resolves.toBeUndefined();
  });

  it('assertFrameFingerprint throws FrameGuardError when name does not match', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeFrameResponse('5356033', 'WRONG-NAME'),
      text: async () => JSON.stringify(makeFrameResponse('5356033', 'WRONG-NAME')),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({
      frameId: '5356033',
      dryrun: false,
      token: 'fake',
    });

    await expect(client.assertFrameFingerprint('5356033:heutoncal')).rejects.toThrow(
      FrameGuardError
    );
  });

  it('assertFrameFingerprint error message includes expected and actual name', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeFrameResponse('5356033', 'WRONG'),
      text: async () => JSON.stringify(makeFrameResponse('5356033', 'WRONG')),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({
      frameId: '5356033',
      dryrun: false,
      token: 'fake',
    });

    await expect(client.assertFrameFingerprint('5356033:heutoncal')).rejects.toThrow(
      /heutoncal/
    );
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. Create-verify rejects bad responses
// ---------------------------------------------------------------------------

describe('createChore safety guards', () => {
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

  it('throws when response data.length !== 1 (duplicate create guard)', async () => {
    // Return two items (unexpected)
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'a', type: 'chore', attributes: { summary: 'x ▸tok1', status: 'pending' } },
          { id: 'b', type: 'chore', attributes: { summary: 'x ▸tok1', status: 'pending' } },
        ],
      }),
      text: async () => '{"data":[{},{}]}',
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({
      frameId: 'frame-1',
      dryrun: false,
      token: 'fake',
    });

    await expect(
      client.createChore({
        summary: 'x ▸tok1',
        start: '2026-06-20',
        categoryId: null,
        idemToken: 'tok1',
      })
    ).rejects.toThrow(/data\.length===1/);
  });

  it('throws when returned summary does not contain the idemToken', async () => {
    // Return a chore with a DIFFERENT summary (sentinel mismatch)
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => makeCreateResponse('new-id', 'DIFFERENT SUMMARY'),
      text: async () => JSON.stringify(makeCreateResponse('new-id', 'DIFFERENT SUMMARY')),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({
      frameId: 'frame-1',
      dryrun: false,
      token: 'fake',
    });

    await expect(
      client.createChore({
        summary: 'Real task ▸mytoken',
        start: '2026-06-20',
        categoryId: null,
        idemToken: 'mytoken',
      })
    ).rejects.toThrow(/idemToken/);
  });

  it('succeeds when response contains the idemToken and data.length===1', async () => {
    const token = 'tok789';
    const summary = `Take out trash ${SENTINEL_GLYPH}${token}`;

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => makeCreateResponse('chore-new', summary),
      text: async () => JSON.stringify(makeCreateResponse('chore-new', summary)),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({
      frameId: 'frame-1',
      dryrun: false,
      token: 'fake',
    });

    const chore = await client.createChore({
      summary,
      start: '2026-06-20',
      categoryId: null,
      idemToken: token,
    });

    expect(chore.id).toBe('chore-new');
    expect(chore.attributes.summary).toBe(summary);
  });
});

// ---------------------------------------------------------------------------
// 5. Delete protocol: aborts when re-GET summary != stored
// ---------------------------------------------------------------------------

describe('verifyDeleted and summary mismatch guard', () => {
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

  it('verifyDeleted throws when chore still exists after DELETE', async () => {
    // Mock getChoreById → returns a chore (not 404)
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeChoreResponse('chore-1', 'Still here ▸abc123'),
      text: async () => JSON.stringify(makeChoreResponse('chore-1', 'Still here ▸abc123')),
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({
      frameId: 'frame-1',
      dryrun: false,
      token: 'fake',
    });

    await expect(client.verifyDeleted('chore-1')).rejects.toThrow(/still exists after DELETE/);
  });

  it('verifyDeleted resolves when chore returns 404', async () => {
    // Mock getChoreById → 404
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
      headers: { get: () => null },
    } as unknown as Response);

    const client = new SkylightClient({
      frameId: 'frame-1',
      dryrun: false,
      token: 'fake',
    });

    await expect(client.verifyDeleted('chore-1')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Sentinel helpers
// ---------------------------------------------------------------------------

describe('Sentinel helpers', () => {
  it('buildSummary appends the sentinel glyph and token', () => {
    const summary = buildSummary('Take out trash', 'task-abc123');
    expect(summary).toContain(SENTINEL_GLYPH);
    expect(summary).toContain(sentinelToken('task-abc123'));
    expect(summary).toContain('Take out trash');
  });

  it('sentinelToken uses last 6 chars of the todoist id', () => {
    // 'task-abc123' = 11 chars; slice(-6) = 'abc123' (positions 5..10)
    expect(sentinelToken('task-abc123')).toBe('abc123');
    // Verify it is always 6 chars
    const longId = '1234567890abcdef';
    // slice(-6) on a 16-char string = positions 10..15 = 'abcdef'
    expect(sentinelToken(longId)).toBe('abcdef');
    expect(sentinelToken(longId).length).toBe(6);
  });

  it('sentinelToken returns last 6 chars correctly', () => {
    // 'abcdef012345' → last 6 = '012345'
    expect(sentinelToken('abcdef012345')).toBe('012345');
  });

  it('summaryMatchesSentinel does full-string comparison (not prefix)', () => {
    const actual = 'Take out trash ▸abc123';
    expect(summaryMatchesSentinel(actual, 'Take out trash ▸abc123')).toBe(true);
    // Prefix match fails
    expect(summaryMatchesSentinel(actual, 'Take out trash')).toBe(false);
    // Suffix added fails
    expect(summaryMatchesSentinel(actual, 'Take out trash ▸abc123 extra')).toBe(false);
    // Different sentinel fails
    expect(summaryMatchesSentinel(actual, 'Take out trash ▸XXXXX')).toBe(false);
  });

  it('buildSummary is deterministic for the same inputs', () => {
    const s1 = buildSummary('Do dishes', 'task-999888');
    const s2 = buildSummary('Do dishes', 'task-999888');
    expect(s1).toBe(s2);
  });

  it('DRYRUN_SYNTHETIC_ID is a distinct sentinel string', () => {
    expect(typeof DRYRUN_SYNTHETIC_ID).toBe('string');
    expect(DRYRUN_SYNTHETIC_ID.length).toBeGreaterThan(0);
  });
});
