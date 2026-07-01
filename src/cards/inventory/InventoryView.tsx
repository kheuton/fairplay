/**
 * FAIRPLAY · InventoryView
 * RE4-style supply grid (or reorderable list): FP-item carrier tasks → inventory-math projections.
 * All item state lives in Todoist via useInventory / useUpdateItemMeta / useAttestItem.
 * Drag-to-rearrange persists x/y (grid) or order (list) via useUpdateItemMeta.
 * Layout toggled by settings.invLayout ('list' | 'grid').
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CardDef, FpTask, InvMeta } from '../../lib/types';
import {
  useInventory,
  useCardTasks,
  useUpdateItemMeta,
  useAttestItem,
  useCreateTask,
  useSeedInventory,
  useCloseTask,
  useDeleteItem,
} from '../../lib/todoist/hooks';
import { useSettings } from '../../state/settings';
import type { InvLayout } from '../../state/settings';
import {
  invEst,
  invStatus,
  invFmt,
  invDateLabel,
  invRunout,
  invRateLabel,
  invChip,
  invDaysLeft,
  normalizeInvMeta,
} from '../../lib/inventory-math';
import { ItemIcon } from '../../shell/icons';
import { SideTaskRow, LoadState } from '../../shell/atoms';
import { CharterPanel } from '../../shell/CharterPanel';
import { QuickAdd } from '../../shell/QuickAdd';
import { getSeedDef } from './seeds';
import { InvGrid, gridDims } from './InvGrid';
import { InvDetail } from './InvDetail';
import { AddSupplyForm } from './AddSupplyForm';
import { InvList } from './InvList';
import type { ItemWithMeta } from './types';
import { sortByOrder, computeReorderWrites } from '../../lib/inventory-order';
import { todayString } from '../../lib/date-utils';
import './inventory.css';

// ─── RestockAlertRow ──────────────────────────────────────────────────────────

interface RestockAlertRowProps {
  item: ItemWithMeta;
  onPick: (id: string) => void;
  existingRestockIds: Set<string>;
  onCreateRestock: (item: ItemWithMeta) => void;
  isCreatingRestock: boolean;
}

function RestockAlertRow({
  item,
  onPick,
  existingRestockIds,
  onCreateRestock,
  isCreatingRestock,
}: RestockAlertRowProps) {
  const { inv } = item;
  const st = invStatus(inv);
  const restockContent = `Restock ${item.name}`;
  const isQueued = existingRestockIds.has(restockContent);

  return (
    <div className={`rs-row ${st}`}>
      <div className="rg" onClick={() => onPick(item.taskId)} style={{ cursor: 'pointer' }}>
        <ItemIcon name={inv.icon} size={19} />
      </div>
      <div style={{ minWidth: 0, cursor: 'pointer' }} onClick={() => onPick(item.taskId)}>
        <div className="nm">{item.name}</div>
        <div className="sub">
          EST {invFmt(invEst(inv))} · ✓{inv.count} ON {invDateLabel(inv.verified)} · {invRateLabel(inv)}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <span className={`chip ${st}`}>{invChip(inv)}</span>
        {isQueued ? (
          <span className="mono up-s" style={{ fontSize: 8, color: 'var(--accent-2)' }}>QUEUED</span>
        ) : (
          <button
            className="btn ghost"
            style={{ padding: '2px 7px', fontSize: 8, letterSpacing: '.06em' }}
            disabled={isCreatingRestock}
            onClick={(e) => { e.stopPropagation(); onCreateRestock(item); }}
          >
            + TASK
          </button>
        )}
      </div>
    </div>
  );
}

// ─── CardTasksSection (shared by side panel + empty state) ───────────────────

interface CardTasksSectionProps {
  tasks: FpTask[];
  onAddTask: () => void;
  onToggleTask: (taskId: string) => void;
}

/** The "TASKS · N" list with a + NEW TASK action. Rendered both in the populated
 *  side panel and in the empty-inventory state, so a card's regular tasks are
 *  never hidden just because no supplies are tracked yet. */
function CardTasksSection({ tasks, onAddTask, onToggleTask }: CardTasksSectionProps) {
  return (
    <>
      <div className="peek-label mono up" style={{ marginTop: 24 }}>
        <span>TASKS · {tasks.length}</span>
        <button
          className="btn ghost"
          style={{ padding: '2px 8px', fontSize: 8, letterSpacing: '.06em' }}
          onClick={onAddTask}
        >
          + NEW TASK
        </button>
      </div>
      {tasks.length === 0 ? (
        <div className="rs-empty">NO OPEN TASKS</div>
      ) : (
        <div className="tlist">
          {tasks.map((t) => (
            <SideTaskRow key={t.id} task={t} onToggle={() => onToggleTask(t.id)} />
          ))}
        </div>
      )}
    </>
  );
}

// ─── InvSidePanel ─────────────────────────────────────────────────────────────

interface InvSidePanelProps {
  items: ItemWithMeta[];
  cardTasks: FpTask[];
  cardId: string;
  onPick: (id: string) => void;
  onToggleTask: (taskId: string) => void;
  onAddTask: () => void;
}

function InvSidePanel({
  items,
  cardTasks,
  cardId,
  onPick,
  onToggleTask,
  onAddTask,
}: InvSidePanelProps) {
  const createTask = useCreateTask();
  const [creatingFor, setCreatingFor] = useState<string | null>(null);

  const alerts = items
    .filter((i) => invStatus(i.inv) !== 'ok')
    .sort((a, b) => {
      const order = { out: 0, low: 1, ok: 2 };
      const sa = invStatus(a.inv);
      const sb = invStatus(b.inv);
      if (sa !== sb) return order[sa] - order[sb];
      return invDaysLeft(a.inv) - invDaysLeft(b.inv);
    });

  // Build a set of open restock task content strings for dedup check
  const restockTaskContents = new Set(
    cardTasks.map((t) => t.content),
  );

  const handleCreateRestock = async (item: ItemWithMeta) => {
    const content = `Restock ${item.name}`;
    setCreatingFor(item.taskId);
    try {
      await createTask.mutateAsync({ content, cardId, due: 'today' });
    } finally {
      setCreatingFor(null);
    }
  };

  return (
    <div className="bs-list" style={{ paddingTop: 16 }}>
      <div className="peek-label mono up">
        <span>RESTOCK ALERTS</span>
        <span>{alerts.length}</span>
      </div>
      {alerts.length === 0 && (
        <div className="rs-empty">ALL SUPPLIES STOCKED ✓</div>
      )}
      {alerts.map((it) => (
        <RestockAlertRow
          key={it.taskId}
          item={it}
          onPick={onPick}
          existingRestockIds={restockTaskContents}
          onCreateRestock={handleCreateRestock}
          isCreatingRestock={creatingFor === it.taskId}
        />
      ))}
      <CardTasksSection
        tasks={cardTasks}
        onAddTask={onAddTask}
        onToggleTask={onToggleTask}
      />
    </div>
  );
}

// ─── Main View ───────────────────────────────────────────────────────────────

interface Props {
  card: CardDef;
}

export default function InventoryView({ card }: Props) {
  const invQuery = useInventory(card.id);
  const cardTasksQuery = useCardTasks(card.id);
  const updateItemMeta = useUpdateItemMeta();
  const attestItem = useAttestItem();
  const deleteItem = useDeleteItem();
  const seedInv = useSeedInventory();
  const closeTask = useCloseTask();
  const qc = useQueryClient();
  const { invDisplay, invLayout } = useSettings();

  const [sel, setSel] = useState<string | null>(null);
  const [showVer, setShowVer] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [qaOpen, setQaOpen] = useState(false);
  // Incrementing counter used to force a re-render when posOverridesRef / orderOverridesRef changes.
  const [, setPosOverrideTick] = useState(0);

  // Per-item debounce timers for position persist (key = taskId)
  const debounceMapRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Optimistic local position overrides: { [taskId]: { x, y } }
  // Cleared when the query re-fetches (items derived from fresh data will match).
  const posOverridesRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // Optimistic local order overrides for list reorder: { [taskId]: order }
  // Set on drop; cleared per-item once the server write settles (mutateAsync.finally).
  const orderOverridesRef = useRef<Map<string, number>>(new Map());

  // Cancel all pending debounce timers on unmount
  useEffect(() => {
    const map = debounceMapRef.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  // Derive items from FP-item carrier tasks, applying optimistic position overrides.
  // posOverridesRef holds { x, y } patches applied immediately on drop so the item
  // holds its new cell while the debounced server write is in flight.
  // normalizeInvMeta fills defaults for any missing/malformed fields (e.g. a user
  // who hand-edits an FP:: payload and omits rate/warn/stack/count would otherwise
  // cause invPerDay to throw TypeError on item.rate.n).
  const rawItems = invQuery.data ?? [];
  const items: ItemWithMeta[] = rawItems
    .filter((t) => t.meta.inv && typeof t.meta.inv === 'object')
    .map((t) => {
      const base = normalizeInvMeta(t.meta.inv as Partial<InvMeta>);
      const over = posOverridesRef.current.get(t.id);
      const ordOver = orderOverridesRef.current.get(t.id);
      // Apply position override (grid), then order override (list), in a single spread.
      const inv = over
        ? { ...base, x: over.x, y: over.y, ...(ordOver !== undefined ? { order: ordOver } : {}) }
        : ordOver !== undefined
        ? { ...base, order: ordOver }
        : base;
      return {
        taskId: t.id,
        name: t.content,
        inv,
      };
    });

  const { cols, rows } = gridDims(items);
  const alerts = items.filter((i) => invStatus(i.inv) !== 'ok').length;
  const selItem = items.find((i) => i.taskId === sel) ?? null;
  // Pre-sorted for list mode; grid mode uses items directly (grid order is x/y position).
  const ordered = sortByOrder(items);
  const cardTasks = cardTasksQuery.data ?? [];

  // Compute nextOrder for AddSupplyForm (max existing order + 1; 0 for empty)
  const nextOrder = items.reduce((m, it) => Math.max(m, it.inv.order ?? -1), -1) + 1;

  // Seed def for this card
  const today = todayString();
  const seedDef = getSeedDef(card.name, today);

  const handleUpdateMeta = useCallback(
    (taskId: string, patch: Partial<InvMeta>) => {
      updateItemMeta.mutate({ taskId, invPatch: patch });
    },
    [updateItemMeta],
  );

  const handleAttest = useCallback(
    (taskId: string, count: number) => {
      attestItem.mutate({ taskId, count });
    },
    [attestItem],
  );

  const handleDelete = useCallback((taskId: string) => {
    deleteItem.mutate(taskId);
    setSel(null);
  }, [deleteItem]);

  const handleDropPos = useCallback(
    (taskId: string, x: number, y: number) => {
      // Optimistic: record the new position immediately so the item renders at its
      // dropped cell without waiting for the debounced server write + refetch.
      posOverridesRef.current.set(taskId, { x, y });
      setPosOverrideTick((n) => n + 1); // trigger re-render so items picks up the override

      // Per-item debounce: cancel only THIS item's pending timer, leaving other
      // items' timers untouched. This way rapid multi-item rearrangement never
      // loses a position write.
      const existing = debounceMapRef.current.get(taskId);
      if (existing !== undefined) clearTimeout(existing);
      const t = setTimeout(() => {
        debounceMapRef.current.delete(taskId);
        updateItemMeta.mutate({ taskId, invPatch: { x, y } });
        // Once the server write is fired we can drop the override; the upcoming
        // query invalidation/refetch will carry the canonical values.
        posOverridesRef.current.delete(taskId);
      }, 800);
      debounceMapRef.current.set(taskId, t);
    },
    [updateItemMeta],
  );

  // ─── List reorder handler ─────────────────────────────────────────────────────
  // Fires when the user drops an item in the list. Applies optimistic order
  // overrides immediately (so the UI reorders instantly), then persists the changed
  // entries SERIALLY. Serialization matters: useUpdateItemMeta is a read-modify-write
  // (GET description → merge → POST), so firing the writes in parallel would let two
  // calls read the same pre-reorder description and clobber each other (lost writes).
  // The diff baseline is the raw SERVER order (not the optimistic `items`) so a reorder
  // started while a prior one is still settling diffs against committed state. Overrides
  // are cleared only after the cache refetch lands, so the list never flashes back.
  const handleReorder = useCallback(
    (orderedIds: string[]) => {
      const currentOrderById = new Map(
        rawItems
          .filter((t) => t.meta.inv && typeof t.meta.inv === 'object')
          .map((t) => [t.id, normalizeInvMeta(t.meta.inv as Partial<InvMeta>).order]),
      );
      const writes = computeReorderWrites(orderedIds, currentOrderById);
      if (writes.length === 0) return;

      // Set overrides for changed ids (unchanged ids: delete any stale override).
      const changed = new Set(writes.map((w) => w.taskId));
      orderedIds.forEach((id, idx) => {
        if (changed.has(id)) {
          orderOverridesRef.current.set(id, idx);
        } else {
          orderOverridesRef.current.delete(id);
        }
      });
      setPosOverrideTick((n) => n + 1); // force re-render

      void (async () => {
        try {
          for (const { taskId, order } of writes) {
            await updateItemMeta.mutateAsync({ taskId, invPatch: { order } });
          }
        } finally {
          // Wait for the cache to reflect the writes before dropping the optimistic
          // overrides, so the list never flashes the pre-reorder order.
          await qc.invalidateQueries({ queryKey: ['fp-tasks'] });
          writes.forEach(({ taskId }) => orderOverridesRef.current.delete(taskId));
          setPosOverrideTick((n) => n + 1);
        }
      })();
    },
    [rawItems, updateItemMeta, qc],
  );

  const handleToggleTask = useCallback(
    (taskId: string) => {
      closeTask.mutate(taskId);
    },
    [closeTask],
  );

  const handleSeed = async () => {
    if (!seedDef) return;
    await seedInv.mutateAsync({ cardId: card.id, items: seedDef.items });
  };

  // Loading / error / no-token states
  if (invQuery.status === 'pending') {
    return (
      <div className="view">
        <ViewHead card={card} items={[]} alerts={0} cols={cols} rows={rows} layout={invLayout} />
        <CharterPanel card={card} />
        <div className="view-body">
          <LoadState status="loading" />
        </div>
      </div>
    );
  }

  if (invQuery.status === 'error') {
    return (
      <div className="view">
        <ViewHead card={card} items={[]} alerts={0} cols={cols} rows={rows} layout={invLayout} />
        <CharterPanel card={card} />
        <div className="view-body">
          <LoadState
            status="error"
            message={String(invQuery.error)}
            retry={() => void invQuery.refetch()}
          />
        </div>
      </div>
    );
  }

  // Empty inventory
  if (items.length === 0) {
    return (
      <div className="view">
        <ViewHead card={card} items={[]} alerts={0} cols={6} rows={3} layout={invLayout} />
        <CharterPanel card={card} />
        <div className="view-body">
          <div className={`inv-empty-panel${cardTasks.length > 0 ? ' has-tasks' : ''}`}>
            <div className="mono up" style={{ fontSize: 10, color: 'var(--ink-3)', marginBottom: 16 }}>
              NO SUPPLIES TRACKED
            </div>
            {seedDef && (
              <button
                className="btn"
                disabled={seedInv.isPending}
                onClick={() => void handleSeed()}
                style={{ marginBottom: 10 }}
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
              <button className="btn ghost" onClick={() => setShowAddForm(true)}>
                + ADD SUPPLY
              </button>
            )}
            {cardTasks.length === 0 && (
              <button className="btn ghost" onClick={() => setQaOpen(true)} style={{ marginTop: 6 }}>
                + ADD TASK
              </button>
            )}
            {cardTasks.length > 0 && (
              <div className="inv-empty-tasks">
                <CardTasksSection
                  tasks={cardTasks}
                  onAddTask={() => setQaOpen(true)}
                  onToggleTask={handleToggleTask}
                />
              </div>
            )}
          </div>
        </div>
        <QuickAdd open={qaOpen} onClose={() => setQaOpen(false)} presetCardId={card.id} />
      </div>
    );
  }

  const legend =
    invDisplay === 'inline'
      ? 'EST ⁄ ✓ VERIFIED'
      : invDisplay === 'toggle'
      ? showVer
        ? 'SHOWING ✓ VERIFIED COUNTS'
        : 'SHOWING EST TODAY'
      : '✓ = LAST VERIFIED · BIG = EST TODAY';

  return (
    <div className="view">
      <ViewHead card={card} items={items} alerts={alerts} cols={cols} rows={rows} layout={invLayout} />
      <CharterPanel card={card} />

      <div className="bespoke">
        {/* Stage */}
        <div className="stage">
          <span className="tick-c tl" />
          <span className="tick-c tr" />
          <span className="tick-c bl" />
          <span className="tick-c br" />

          <div className="stage-head">
            {invLayout === 'list' ? (
              <>
                <div className="lbl">
                  SUPPLY LIST · {items.length} · {card.name.toUpperCase()}
                </div>
                <div className="lbl">DRAG ⋮⋮ TO REORDER · CLICK TO INSPECT ▸</div>
              </>
            ) : (
              <>
                <div className="lbl">
                  SUPPLY GRID · {cols}×{rows} · {card.name.toUpperCase()}
                </div>
                {invDisplay === 'toggle' ? (
                  <div className="seg">
                    <button
                      className={!showVer ? 'on' : ''}
                      onClick={() => setShowVer(false)}
                    >
                      EST TODAY
                    </button>
                    <button
                      className={showVer ? 'on' : ''}
                      onClick={() => setShowVer(true)}
                    >
                      ✓ VERIFIED
                    </button>
                  </div>
                ) : (
                  <div className="lbl">DRAG TO REARRANGE · CLICK TO INSPECT ▸</div>
                )}
              </>
            )}
          </div>

          <div className={`inv-wrap${invLayout === 'list' ? ' list' : ''}`}>
            {invLayout === 'list' ? (
              <div className="inv-list-wrap">
                <InvList
                  items={ordered}
                  selId={sel}
                  onSelect={setSel}
                  onReorder={handleReorder}
                />
              </div>
            ) : (
              <>
                <InvGrid
                  items={items}
                  cols={cols}
                  rows={rows}
                  display={invDisplay}
                  showVer={showVer}
                  sel={sel}
                  setSel={setSel}
                  onDropPos={handleDropPos}
                />
                <div className="inv-legend">
                  <span>
                    <span className="sw" />
                    STOCKED
                  </span>
                  <span>
                    <span className="sw low" />
                    RESTOCK SOON
                  </span>
                  <span>
                    <span className="sw out" />
                    OUT
                  </span>
                  <span style={{ opacity: 0.75 }}>{legend}</span>
                </div>
              </>
            )}
          </div>

          {/* Footer row with add supply */}
          <div className="stage-foot">
            {invLayout === 'list' ? (
              <>
                <span>FORMAT · INVENTORY v2 LIST</span>
                <span />
                <span>
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
                    <button
                      className="btn ghost"
                      style={{ fontSize: 9, padding: '3px 8px' }}
                      onClick={() => setShowAddForm(true)}
                    >
                      + ADD SUPPLY
                    </button>
                  )}
                </span>
              </>
            ) : (
              <>
                <span>FORMAT · INVENTORY v2</span>
                <span>HOVER FOR NAME</span>
                <span>
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
                    <button
                      className="btn ghost"
                      style={{ fontSize: 9, padding: '3px 8px' }}
                      onClick={() => setShowAddForm(true)}
                    >
                      + ADD SUPPLY
                    </button>
                  )}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Side panel */}
        <div className="bespoke-side">
          {selItem ? (
            <InvDetail
              item={selItem}
              onClose={() => setSel(null)}
              onUpdateMeta={handleUpdateMeta}
              onAttest={handleAttest}
              onDelete={handleDelete}
            />
          ) : (
            <>
              <div className="bs-head">
                <div className="peek-label mono up">
                  <span>SUPPLY STATUS</span>
                  <span>{items.length} ITEMS</span>
                </div>
              </div>
              <InvSidePanel
                items={items}
                cardTasks={cardTasks}
                cardId={card.id}
                onPick={setSel}
                onToggleTask={handleToggleTask}
                onAddTask={() => setQaOpen(true)}
              />
            </>
          )}
        </div>
      </div>
      <QuickAdd open={qaOpen} onClose={() => setQaOpen(false)} presetCardId={card.id} />
    </div>
  );
}

// ─── ViewHead (extracted for reuse in loading states) ────────────────────────

function ViewHead({
  card,
  items,
  alerts,
  cols,
  rows,
  layout,
}: {
  card: CardDef;
  items: ItemWithMeta[];
  alerts: number;
  cols: number;
  rows: number;
  layout: InvLayout;
}) {
  return (
    <div className="view-head">
      <div>
        <div className="kicker mono up">
          <span className="tick" />
          CARD · {card.category} · {layout === 'list' ? 'SUPPLY LIST' : 'SUPPLY GRID'} ◆
        </div>
        <div className="view-title">{card.name}</div>
        <div className="view-sub mono" style={{ fontSize: 11 }}>
          {items.length} supplies tracked · estimates live
        </div>
      </div>
      <div className="head-meta">
        <div className={`big${alerts > 0 ? ' coral' : ''}`}>{alerts}</div>
        <div className="mono up" style={{ fontSize: 9.5, marginTop: 6 }}>
          {layout === 'list'
            ? `RESTOCK ALERTS · ${items.length} ITEMS`
            : `RESTOCK ALERTS · ${cols}×${rows} GRID`}
        </div>
      </div>
    </div>
  );
}
