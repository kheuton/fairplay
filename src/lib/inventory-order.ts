/**
 * FAIRPLAY · inventory-order
 * Pure helpers for stable ordering and persistence of inventory items.
 * No React or Todoist dependencies — safe to use in tests and workers.
 */
import type { InvMeta } from './types';

// ─── sortByOrder ──────────────────────────────────────────────────────────────

/**
 * Stable sort by inv.order ascending. Items with undefined order sort last,
 * preserving their relative input order (decorate-sort-undecorate pattern).
 */
export function sortByOrder<T extends { inv: InvMeta }>(items: T[]): T[] {
  return items
    .map((it, i) => ({ it, i }))
    .sort(
      (a, b) =>
        (a.it.inv.order ?? Infinity) - (b.it.inv.order ?? Infinity) || a.i - b.i,
    )
    .map((d) => d.it);
}

// ─── computeReorderWrites ─────────────────────────────────────────────────────

/**
 * Given the desired ordered list of taskIds and a map of each id's currently
 * stored order value, return only the entries whose stored order differs from
 * the new index position (0-based). undefined stored order always counts as
 * changed so a first-time reorder produces a full write for every item.
 */
export function computeReorderWrites(
  orderedIds: string[],
  currentOrderById: Map<string, number | undefined>,
): Array<{ taskId: string; order: number }> {
  const writes: Array<{ taskId: string; order: number }> = [];
  orderedIds.forEach((id, idx) => {
    if (currentOrderById.get(id) !== idx) {
      writes.push({ taskId: id, order: idx });
    }
  });
  return writes;
}
