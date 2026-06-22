/**
 * FAIRPLAY · MobileInventory
 * Inventory section rendered below the task list on mobile card detail.
 * Supports both list mode (default) and grid mode via invLayout setting.
 * Mirrors InventoryView's item derivation + optimistic order override pattern.
 */
import React, { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CardDef, InvMeta } from '../lib/types';
import {
  useInventory,
  useUpdateItemMeta,
  useAttestItem,
  useDeleteItem,
  useSeedInventory,
} from '../lib/todoist/hooks';
import { useSettings } from '../state/settings';
import { normalizeInvMeta } from '../lib/inventory-math';
import { sortByOrder, computeReorderWrites } from '../lib/inventory-order';
import { todayString } from '../lib/date-utils';
import { gridDims } from '../cards/inventory/InvGrid';
import { InvGrid } from '../cards/inventory/InvGrid';
import { InvList } from '../cards/inventory/InvList';
import { AddSupplyForm } from '../cards/inventory/AddSupplyForm';
import type { ItemWithMeta } from '../cards/inventory/types';
import { MobileInvSheet } from './MobileInvSheet';
import { getSeedDef } from '../cards/inventory/seeds';
import '../cards/inventory/inventory.css';

// ─── MobileInventory ──────────────────────────────────────────────────────────

interface MobileInventoryProps {
  card: CardDef;
}

export function MobileInventory({ card }: MobileInventoryProps) {
  const invQuery = useInventory(card.id);
  const updateItemMeta = useUpdateItemMeta();
  const attestItem = useAttestItem();
  const deleteItem = useDeleteItem();
  const seedInv = useSeedInventory();
  const qc = useQueryClient();
  const invLayout = useSettings((s) => s.invLayout);
  const invDisplay = useSettings((s) => s.invDisplay);

  const [sel, setSel] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [, setPosOverrideTick] = useState(0);

  // Optimistic order overrides (list reorder); same pattern as desktop.
  const orderOverridesRef = useRef<Map<string, number>>(new Map());
  // Optimistic position overrides (grid drag).
  const posOverridesRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const debounceMapRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Return nothing while loading — fp-tasks is likely already loaded by the
  // task list above; this null guard avoids flash/duplicate error states.
  if (invQuery.status !== 'success') return null;

  const rawItems = invQuery.data ?? [];
  const items: ItemWithMeta[] = rawItems
    .filter((t) => t.meta.inv && typeof t.meta.inv === 'object')
    .map((t) => {
      const base = normalizeInvMeta(t.meta.inv as Partial<InvMeta>);
      const over = posOverridesRef.current.get(t.id);
      const ordOver = orderOverridesRef.current.get(t.id);
      const inv = over
        ? { ...base, x: over.x, y: over.y, ...(ordOver !== undefined ? { order: ordOver } : {}) }
        : ordOver !== undefined
        ? { ...base, order: ordOver }
        : base;
      return { taskId: t.id, name: t.content, inv };
    });

  const ordered = sortByOrder(items);
  const { cols, rows } = gridDims(items);
  const selItem = items.find((i) => i.taskId === sel) ?? null;
  const nextOrder = items.reduce((m, it) => Math.max(m, it.inv.order ?? -1), -1) + 1;

  const seedDef = getSeedDef(card.name, todayString());

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const handleUpdateMeta = (taskId: string, patch: Partial<InvMeta>) => {
    updateItemMeta.mutate({ taskId, invPatch: patch });
  };

  const handleAttest = (taskId: string, count: number) => {
    attestItem.mutate({ taskId, count });
  };

  const handleDelete = (taskId: string) => {
    deleteItem.mutate(taskId);
    setSel(null);
  };

  // Serialized + server-baseline reorder persist; see InventoryView.handleReorder
  // for the rationale (read-modify-write writes must not overlap; clear overrides
  // only after the refetch so the list never flashes the pre-reorder order).
  const handleReorder = (orderedIds: string[]) => {
    const currentOrderById = new Map(
      rawItems
        .filter((t) => t.meta.inv && typeof t.meta.inv === 'object')
        .map((t) => [t.id, normalizeInvMeta(t.meta.inv as Partial<InvMeta>).order]),
    );
    const writes = computeReorderWrites(orderedIds, currentOrderById);
    if (writes.length === 0) return;

    const changed = new Set(writes.map((w) => w.taskId));
    orderedIds.forEach((id, idx) => {
      if (changed.has(id)) {
        orderOverridesRef.current.set(id, idx);
      } else {
        orderOverridesRef.current.delete(id);
      }
    });
    setPosOverrideTick((n) => n + 1);

    void (async () => {
      try {
        for (const { taskId, order } of writes) {
          await updateItemMeta.mutateAsync({ taskId, invPatch: { order } });
        }
      } finally {
        await qc.invalidateQueries({ queryKey: ['fp-tasks'] });
        writes.forEach(({ taskId }) => orderOverridesRef.current.delete(taskId));
        setPosOverrideTick((n) => n + 1);
      }
    })();
  };

  const handleDropPos = (taskId: string, x: number, y: number) => {
    posOverridesRef.current.set(taskId, { x, y });
    setPosOverrideTick((n) => n + 1);
    const existing = debounceMapRef.current.get(taskId);
    if (existing !== undefined) clearTimeout(existing);
    const t = setTimeout(() => {
      debounceMapRef.current.delete(taskId);
      updateItemMeta.mutate({ taskId, invPatch: { x, y } });
      posOverridesRef.current.delete(taskId);
    }, 800);
    debounceMapRef.current.set(taskId, t);
  };

  const handleSeed = async () => {
    if (!seedDef) return;
    await seedInv.mutateAsync({ cardId: card.id, items: seedDef.items });
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* Section header */}
      <div className="m-cat mono up m-inv-cat">
        <span>SUPPLIES · {items.length}</span>
        <span className="ln" />
      </div>

      {items.length === 0 ? (
        <div className="m-inv-empty">
          {seedDef && (
            <button
              className="m-sheet-add"
              disabled={seedInv.isPending}
              onClick={() => void handleSeed()}
            >
              {seedInv.isPending ? 'SEEDING...' : 'SEED DEFAULT LOADOUT'}
            </button>
          )}
          {showAddForm ? (
            <AddSupplyForm
              cardId={card.id}
              items={items}
              gridCols={6}
              gridRows={3}
              nextOrder={nextOrder}
              onDone={() => setShowAddForm(false)}
            />
          ) : (
            <button className="m-sheet-add" onClick={() => setShowAddForm(true)}>
              + ADD SUPPLY
            </button>
          )}
        </div>
      ) : (
        <>
          {invLayout === 'list' ? (
            <InvList
              variant="mobile"
              items={ordered}
              selId={sel}
              onSelect={setSel}
              onReorder={handleReorder}
            />
          ) : (
            <div className="m-inv-gridscroll">
              <InvGrid
                items={ordered}
                cols={cols}
                rows={rows}
                display={invDisplay}
                showVer={false}
                sel={sel}
                setSel={setSel}
                onDropPos={handleDropPos}
              />
            </div>
          )}

          {/* Add supply button */}
          <div className="m-inv-add">
            {showAddForm ? (
              <AddSupplyForm
                cardId={card.id}
                items={items}
                gridCols={cols}
                gridRows={rows}
                nextOrder={nextOrder}
                onDone={() => setShowAddForm(false)}
              />
            ) : (
              <button className="m-sheet-add" onClick={() => setShowAddForm(true)}>
                + ADD SUPPLY
              </button>
            )}
          </div>
        </>
      )}

      {/* Item detail sheet */}
      <MobileInvSheet
        item={selItem}
        onClose={() => setSel(null)}
        onUpdateMeta={handleUpdateMeta}
        onAttest={handleAttest}
        onDelete={handleDelete}
      />
    </>
  );
}
