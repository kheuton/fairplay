/**
 * FAIRPLAY · AddSupplyForm
 * Inline form to add a new supply item. Sets both inv.order (for list mode)
 * and inv.x/y (for grid placement) so toggling layouts keeps a sane position
 * in either mode. Extracted from InventoryView.
 */
import React, { useState } from 'react';
import type { InvMeta } from '../../lib/types';
import { useSeedInventory } from '../../lib/todoist/hooks';
import { todayString } from '../../lib/date-utils';
import { firstFreeSlot } from './InvGrid';
import type { ItemWithMeta } from './types';

// ─── AddSupplyForm ────────────────────────────────────────────────────────────

interface AddSupplyFormProps {
  cardId: string;
  items: ItemWithMeta[];
  gridCols: number;
  gridRows: number;
  nextOrder: number;
  onDone: () => void;
}

export function AddSupplyForm({ cardId, items, gridCols, gridRows, nextOrder, onDone }: AddSupplyFormProps) {
  const [name, setName] = useState('');
  const seedInv = useSeedInventory();
  const [busy, setBusy] = useState(false);

  const handleAdd = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    const slot = firstFreeSlot(items, gridCols, gridRows);
    const today = todayString();
    const inv: InvMeta = {
      icon: 'generic',
      w: 1, h: 1,
      x: slot.x, y: slot.y,
      stack: 10,
      count: 0,
      verified: today,
      rate: { n: 1, per: 'week' },
      warn: { mode: 'days', value: 7 },
      order: nextOrder,
    };
    try {
      await seedInv.mutateAsync({ cardId, items: [{ name: trimmed, inv }] });
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inv-add-form">
      <input
        className="inv-add-input mono"
        placeholder="SUPPLY NAME"
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void handleAdd();
          if (e.key === 'Escape') onDone();
        }}
      />
      <button className="btn" disabled={busy || !name.trim()} onClick={() => void handleAdd()}>
        {busy ? '...' : 'ADD'}
      </button>
      <button className="btn ghost" onClick={onDone}>✕</button>
    </div>
  );
}
