import { describe, it, expect } from 'vitest';
import { sortByOrder, computeReorderWrites } from './inventory-order';
import type { InvMeta } from './types';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/** Minimal InvMeta base — only inv.order matters for these tests. */
function makeInv(order?: number): InvMeta {
  return {
    icon: 'generic',
    w: 1, h: 1, x: 0, y: 0,
    stack: 10,
    count: 0,
    verified: '2026-01-01',
    rate: { n: 1, per: 'week' },
    warn: { mode: 'days', value: 7 },
    ...(order !== undefined ? { order } : {}),
  } as InvMeta;
}

function item(taskId: string, order?: number) {
  return { taskId, name: taskId, inv: makeInv(order) };
}

// ─── sortByOrder ──────────────────────────────────────────────────────────────

describe('sortByOrder', () => {
  it('(a) respects defined order; breaks ties by input order', () => {
    const items = [
      item('b', 2),
      item('a', 1),
      item('c', 2), // same order as 'b' — should come after it (input order)
    ];
    const result = sortByOrder(items);
    expect(result.map((r) => r.taskId)).toEqual(['a', 'b', 'c']);
  });

  it('(b) all-undefined orders preserve input order', () => {
    const items = [item('x'), item('y'), item('z')];
    const result = sortByOrder(items);
    expect(result.map((r) => r.taskId)).toEqual(['x', 'y', 'z']);
  });

  it('(c) mixed defined+undefined: defined sort by value, undefined sort last preserving input order', () => {
    const items = [
      item('u1'),       // undefined → last
      item('a', 0),     // order 0
      item('u2'),       // undefined → last, after u1
      item('b', 1),     // order 1
    ];
    const result = sortByOrder(items);
    expect(result.map((r) => r.taskId)).toEqual(['a', 'b', 'u1', 'u2']);
  });

  it('does not mutate the input array', () => {
    const items = [item('b', 1), item('a', 0)];
    const original = [...items];
    sortByOrder(items);
    expect(items[0].taskId).toBe(original[0].taskId);
    expect(items[1].taskId).toBe(original[1].taskId);
  });
});

// ─── computeReorderWrites ─────────────────────────────────────────────────────

describe('computeReorderWrites', () => {
  it('(d) returns only changed entries when some match current order', () => {
    // ids already at correct indices 0,1,2; only 'c' differs (stored=5)
    const orderedIds = ['a', 'b', 'c'];
    const current = new Map<string, number | undefined>([
      ['a', 0],
      ['b', 1],
      ['c', 5], // stored 5, should be 2 → write
    ]);
    const writes = computeReorderWrites(orderedIds, current);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ taskId: 'c', order: 2 });
  });

  it('first-time reorder: all undefined stored orders produce a full write (0..n-1)', () => {
    const orderedIds = ['p', 'q', 'r'];
    const current = new Map<string, number | undefined>([
      ['p', undefined],
      ['q', undefined],
      ['r', undefined],
    ]);
    const writes = computeReorderWrites(orderedIds, current);
    expect(writes).toHaveLength(3);
    expect(writes).toEqual([
      { taskId: 'p', order: 0 },
      { taskId: 'q', order: 1 },
      { taskId: 'r', order: 2 },
    ]);
  });

  it('(e) top->bottom move produces correct contiguous writes', () => {
    // Items were [a,b,c,d]; move 'a' to bottom → [b,c,d,a]
    const orderedIds = ['b', 'c', 'd', 'a'];
    const current = new Map<string, number | undefined>([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3],
    ]);
    const writes = computeReorderWrites(orderedIds, current);
    // b:0 (was 1), c:1 (was 2), d:2 (was 3), a:3 (was 0) — all 4 differ
    expect(writes).toHaveLength(4);
    expect(writes).toEqual([
      { taskId: 'b', order: 0 },
      { taskId: 'c', order: 1 },
      { taskId: 'd', order: 2 },
      { taskId: 'a', order: 3 },
    ]);
  });

  it('(e) bottom->top move produces correct contiguous writes', () => {
    // Items were [a,b,c,d]; move 'd' to top → [d,a,b,c]
    const orderedIds = ['d', 'a', 'b', 'c'];
    const current = new Map<string, number | undefined>([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3],
    ]);
    const writes = computeReorderWrites(orderedIds, current);
    // d:0 (was 3), a:1 (was 0), b:2 (was 1), c:3 (was 2) — all 4 differ
    expect(writes).toHaveLength(4);
    expect(writes).toEqual([
      { taskId: 'd', order: 0 },
      { taskId: 'a', order: 1 },
      { taskId: 'b', order: 2 },
      { taskId: 'c', order: 3 },
    ]);
  });

  it('returns empty array when nothing changed', () => {
    const orderedIds = ['a', 'b'];
    const current = new Map<string, number | undefined>([
      ['a', 0],
      ['b', 1],
    ]);
    const writes = computeReorderWrites(orderedIds, current);
    expect(writes).toHaveLength(0);
  });
});
