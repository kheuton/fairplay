/**
 * FAIRPLAY · inventory/types
 * Shared item type used across all inventory sub-components.
 */
import type { InvMeta } from '../../lib/types';

// ─── ItemWithMeta ─────────────────────────────────────────────────────────────

export interface ItemWithMeta {
  taskId: string;
  name: string;
  inv: InvMeta;
}
