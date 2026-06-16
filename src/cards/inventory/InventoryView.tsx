/**
 * FAIRPLAY · InventoryView
 * RE4-style supply grid: FP-item carrier tasks → inventory-math projections.
 * All item state lives in Todoist via useInventory / useUpdateItemMeta / useAttestItem.
 * Drag-to-rearrange persists x/y via useUpdateItemMeta debounced ~800ms.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { ItemIcon, ICON_ORDER, ICON_LIB } from '../../shell/icons';
import { SideTaskRow, Stp, StpNum, LoadState } from '../../shell/atoms';
import { CharterPanel } from '../../shell/CharterPanel';
import { QuickAdd } from '../../shell/QuickAdd';
import { format } from 'date-fns';
import { getSeedDef } from './seeds';
import './inventory.css';

const INV_CELL = 64;

// ─── Types ───────────────────────────────────────────────────────────────────

interface ItemWithMeta {
  taskId: string;
  name: string;
  inv: InvMeta;
}

// ─── Drag state ──────────────────────────────────────────────────────────────

interface DragState {
  id: string;
  gx: number;
  gy: number;
  offX: number;
  offY: number;
  curX: number;
  curY: number;
  tx: number;
  ty: number;
  ok: boolean;
  moved: boolean;
  sx: number;
  sy: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayString(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

/** Find first free 1x1 slot in a cols×rows grid given occupied items. */
function firstFreeSlot(
  items: ItemWithMeta[],
  cols: number,
  rows: number,
): { x: number; y: number } {
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const occupied = items.some(
        (it) =>
          x < it.inv.x + it.inv.w &&
          it.inv.x < x + 1 &&
          y < it.inv.y + it.inv.h &&
          it.inv.y < y + 1,
      );
      if (!occupied) return { x, y };
    }
  }
  // Extend grid: place below last row
  return { x: 0, y: rows };
}

/** Dynamic grid dims: default 6x3, grow to fit all items. */
function gridDims(items: ItemWithMeta[]): { cols: number; rows: number } {
  let maxCol = 6;
  let maxRow = 3;
  for (const it of items) {
    maxCol = Math.max(maxCol, it.inv.x + it.inv.w);
    maxRow = Math.max(maxRow, it.inv.y + it.inv.h);
  }
  return { cols: maxCol, rows: maxRow };
}

// ─── InvCount ────────────────────────────────────────────────────────────────

interface InvCountProps {
  inv: InvMeta;
  est: number;
  display: 'stacked' | 'inline' | 'toggle';
  showVer: boolean;
}

function InvCount({ inv, est, display, showVer }: InvCountProps) {
  const e = invFmt(est);
  if (display === 'toggle') {
    return (
      <div className="ii-count mono">
        {showVer ? `✓${inv.count}` : e}
        <span className="ii-stack">/{inv.stack}</span>
      </div>
    );
  }
  if (display === 'inline') {
    return (
      <div className="ii-count mono">
        {e}
        <span className="ii-verin"> ⁄ ✓{inv.count}</span>
      </div>
    );
  }
  // stacked (default)
  return (
    <>
      <div className="ii-ver mono">✓{inv.count}</div>
      <div className="ii-count mono">
        {e}
        <span className="ii-stack">/{inv.stack}</span>
      </div>
    </>
  );
}

// ─── InvItemBox ──────────────────────────────────────────────────────────────

interface InvItemBoxProps {
  item: ItemWithMeta;
  display: 'stacked' | 'inline' | 'toggle';
  showVer: boolean;
  sel: boolean;
  drag: DragState | null;
  onDown: (e: React.PointerEvent, item: ItemWithMeta) => void;
  onMove: (e: React.PointerEvent, item: ItemWithMeta) => void;
  onUp: (e: React.PointerEvent, item: ItemWithMeta) => void;
}

function InvItemBox({
  item,
  display,
  showVer,
  sel,
  drag,
  onDown,
  onMove,
  onUp,
}: InvItemBoxProps) {
  const { inv } = item;
  const est = invEst(inv);
  const st = invStatus(inv);
  const isDrag = !!(drag && drag.id === item.taskId && drag.moved);
  const left = isDrag ? drag!.curX : inv.x * INV_CELL;
  const top = isDrag ? drag!.curY : inv.y * INV_CELL;
  const iconSize =
    inv.w >= 2 && inv.h >= 2 ? 46 : inv.w + inv.h >= 3 ? 32 : 27;

  const runout = st === 'out' ? 'OUT NOW' : `OUT ${invRunout(inv)}`;

  return (
    <div
      className={`inv-item ${st}${sel ? ' sel' : ''}${isDrag ? ' dragging' : ''}`}
      style={{
        left: left + 4,
        top: top + 4,
        width: inv.w * INV_CELL - 7,
        height: inv.h * INV_CELL - 7,
      }}
      onPointerDown={(e) => onDown(e, item)}
      onPointerMove={(e) => onMove(e, item)}
      onPointerUp={(e) => onUp(e, item)}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="ii-icon">
        <ItemIcon name={inv.icon} size={iconSize} />
      </div>
      <InvCount inv={inv} est={est} display={display} showVer={showVer} />
      <div className="ii-tip mono up-s">
        {item.name} · EST {invFmt(est)} · {runout}
      </div>
    </div>
  );
}

// ─── InvGrid ─────────────────────────────────────────────────────────────────

interface InvGridProps {
  items: ItemWithMeta[];
  cols: number;
  rows: number;
  display: 'stacked' | 'inline' | 'toggle';
  showVer: boolean;
  sel: string | null;
  setSel: (id: string | null) => void;
  onDropPos: (taskId: string, x: number, y: number) => void;
}

function InvGrid({
  items,
  cols,
  rows,
  display,
  showVer,
  sel,
  setSel,
  onDropPos,
}: InvGridProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const W = cols * INV_CELL;
  const H = rows * INV_CELL;

  const fits = useCallback(
    (item: ItemWithMeta, x: number, y: number): boolean => {
      const { inv } = item;
      if (x < 0 || y < 0 || x + inv.w > cols || y + inv.h > rows) return false;
      return !items.some((o) => {
        if (o.taskId === item.taskId) return false;
        return (
          x < o.inv.x + o.inv.w &&
          o.inv.x < x + inv.w &&
          y < o.inv.y + o.inv.h &&
          o.inv.y < y + inv.h
        );
      });
    },
    [items, cols, rows],
  );

  const onDown = (e: React.PointerEvent, item: ItemWithMeta) => {
    if (e.button !== 0) return;
    const r = ref.current!.getBoundingClientRect();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({
      id: item.taskId,
      gx: r.left,
      gy: r.top,
      offX: e.clientX - (r.left + item.inv.x * INV_CELL),
      offY: e.clientY - (r.top + item.inv.y * INV_CELL),
      curX: item.inv.x * INV_CELL,
      curY: item.inv.y * INV_CELL,
      tx: item.inv.x,
      ty: item.inv.y,
      ok: true,
      moved: false,
      sx: e.clientX,
      sy: e.clientY,
    });
  };

  const onMove = (e: React.PointerEvent, item: ItemWithMeta) => {
    setDrag((d) => {
      if (!d || d.id !== item.taskId) return d;
      const moved =
        d.moved ||
        Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 5;
      if (!moved) return d;
      const curX = e.clientX - d.offX - d.gx;
      const curY = e.clientY - d.offY - d.gy;
      const tx = Math.max(
        0,
        Math.min(cols - item.inv.w, Math.round(curX / INV_CELL)),
      );
      const ty = Math.max(
        0,
        Math.min(rows - item.inv.h, Math.round(curY / INV_CELL)),
      );
      return { ...d, moved, curX, curY, tx, ty, ok: fits(item, tx, ty) };
    });
  };

  const onUp = (e: React.PointerEvent, item: ItemWithMeta) => {
    if (!drag || drag.id !== item.taskId) return;
    if (!drag.moved) {
      setSel(sel === item.taskId ? null : item.taskId);
    } else if (drag.ok) {
      onDropPos(item.taskId, drag.tx, drag.ty);
    }
    setDrag(null);
  };

  const dragItem = drag?.moved ? items.find((i) => i.taskId === drag.id) : null;

  return (
    <div
      className={`inv-grid${dragItem ? ' dragging' : ''}`}
      ref={ref}
      style={{ width: W + 1, height: H + 1 }}
      onClick={() => setSel(null)}
    >
      {dragItem && drag && (
        <div
          className={`inv-target${drag.ok ? '' : ' bad'}`}
          style={{
            left: drag.tx * INV_CELL,
            top: drag.ty * INV_CELL,
            width: dragItem.inv.w * INV_CELL + 1,
            height: dragItem.inv.h * INV_CELL + 1,
          }}
        />
      )}
      {items.map((it) => (
        <InvItemBox
          key={it.taskId}
          item={it}
          display={display}
          showVer={showVer}
          sel={sel === it.taskId}
          drag={drag}
          onDown={onDown}
          onMove={onMove}
          onUp={onUp}
        />
      ))}
    </div>
  );
}

// ─── InvDetail ───────────────────────────────────────────────────────────────

interface InvDetailProps {
  item: ItemWithMeta;
  onClose: () => void;
  onUpdateMeta: (taskId: string, patch: Partial<InvMeta>) => void;
  onAttest: (taskId: string, count: number) => void;
  onDelete: (taskId: string) => void;
}

function InvDetail({ item, onClose, onUpdateMeta, onAttest, onDelete }: InvDetailProps) {
  const { inv } = item;
  const est = invEst(inv);
  const st = invStatus(inv);
  const [logN, setLogN] = useState(inv.count);
  const [confirmDel, setConfirmDel] = useState(false);

  // Resync the log field whenever the verified count changes (incl. background refetch).
  useEffect(() => {
    setLogN(inv.count);
  }, [inv.count]);

  // Collapse the delete-confirm only when switching to a different item — a count
  // refetch for the SAME item must not yank the confirm out from under the user.
  useEffect(() => {
    setConfirmDel(false);
  }, [item.taskId]);

  const w = inv.warn ?? { mode: 'days' as const, value: 7 };
  const rstep = inv.rate.n <= 1 ? 0.1 : inv.rate.n <= 5 ? 0.5 : 1;

  const setRate = (n: number) =>
    onUpdateMeta(item.taskId, {
      rate: { ...inv.rate, n: Math.max(0.1, Math.round(n * 10) / 10) },
    });

  const chipText =
    st === 'ok'
      ? 'STOCKED'
      : st === 'low'
      ? `RESTOCK · ${invChip(inv)}`
      : 'OUT OF STOCK';

  return (
    <div className="inv-detail">
      <div className="id-head">
        <div className="id-glyph">
          <ItemIcon name={inv.icon} size={32} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="id-name">{item.name}</div>
          <div style={{ marginTop: 6 }}>
            <span className={`chip ${st}`}>{chipText}</span>
          </div>
        </div>
        <div className="id-x" onClick={onClose}>✕</div>
      </div>

      {/* Stats */}
      <div className="stats small">
        <div className="stat">
          <div className="v">{inv.count}</div>
          <div className="k">VERIFIED {invDateLabel(inv.verified)}</div>
        </div>
        <div className="stat">
          <div className={`v${st !== 'ok' ? ' coral' : ''}`}>{invFmt(est)}</div>
          <div className="k">EST TODAY</div>
        </div>
        <div className="stat">
          <div className={`v sm${st !== 'ok' ? ' coral' : ''}`}>{invRunout(inv)}</div>
          <div className="k">RUNS OUT</div>
        </div>
      </div>

      {/* Log verified count */}
      <div>
        <div className="peek-label mono up"><span>LOG VERIFIED COUNT</span></div>
        <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
          <Stp
            label={String(logN)}
            dec={() => setLogN(Math.max(0, logN - 1))}
            inc={() => setLogN(Math.min(999, logN + 1))}
          />
          <button
            className="btn coral"
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={() => onAttest(item.taskId, logN)}
          >
            LOG AS OF TODAY
          </button>
        </div>
      </div>

      {/* Consumption + alerts */}
      <div>
        <div className="peek-label mono up"><span>CONSUMPTION + ALERTS</span></div>
        <div className="cfg-row">
          <span className="lbl">BURN RATE</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <StpNum
              value={inv.rate.n}
              dec={(base) => setRate(base - rstep)}
              inc={(base) => setRate(base + rstep)}
              onCommit={(n) => onUpdateMeta(item.taskId, { rate: { ...inv.rate, n: Math.max(0.1, Math.round(n * 10) / 10) } })}
              min={0.1}
              max={999}
            />
            <div className="seg mini">
              {(['day', 'week', 'month'] as const).map((p) => (
                <button
                  key={p}
                  className={inv.rate.per === p ? 'on' : ''}
                  onClick={() =>
                    onUpdateMeta(item.taskId, { rate: { ...inv.rate, per: p } })
                  }
                >
                  {{ day: '/DAY', week: '/WK', month: '/MO' }[p]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="cfg-row">
          <span className="lbl">STACK SIZE</span>
          <StpNum
            value={inv.stack}
            dec={(base) => onUpdateMeta(item.taskId, { stack: Math.max(1, base - (base > 20 ? 5 : 1)) })}
            inc={(base) => onUpdateMeta(item.taskId, { stack: base + (base >= 20 ? 5 : 1) })}
            onCommit={(n) => onUpdateMeta(item.taskId, { stack: Math.max(1, Math.round(n)) })}
            min={1}
            max={9999}
          />
        </div>
        <div className="cfg-row">
          <span className="lbl">WARN WHEN</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <div className="seg mini">
              <button
                className={w.mode === 'days' ? 'on' : ''}
                onClick={() =>
                  onUpdateMeta(item.taskId, {
                    warn: { mode: 'days', value: 7 },
                  })
                }
              >
                ≤ DAYS
              </button>
              <button
                className={w.mode === 'count' ? 'on' : ''}
                onClick={() =>
                  onUpdateMeta(item.taskId, {
                    warn: { mode: 'count', value: 1 },
                  })
                }
              >
                ≤ COUNT
              </button>
            </div>
            <StpNum
              value={w.value}
              dec={(base) => onUpdateMeta(item.taskId, { warn: { ...w, value: Math.max(w.mode === 'count' ? 0.5 : 1, base - (w.mode === 'count' ? 0.5 : 1)) } })}
              inc={(base) => onUpdateMeta(item.taskId, { warn: { ...w, value: base + (w.mode === 'count' ? 0.5 : 1) } })}
              onCommit={(n) => onUpdateMeta(item.taskId, { warn: { ...w, value: w.mode === 'count' ? Math.max(0.5, Math.round(n * 2) / 2) : Math.max(1, Math.round(n)) } })}
              min={w.mode === 'count' ? 0.5 : 1}
              max={9999}
            />
          </div>
        </div>
      </div>

      {/* Icon picker */}
      <div>
        <div className="peek-label mono up">
          <span>ICON</span>
          <span>{ICON_ORDER.length}</span>
        </div>
        <div className="icon-pick" style={{ marginTop: 10 }}>
          {ICON_ORDER.map((k) => (
            <div
              key={k}
              className={`ip${inv.icon === k ? ' on' : ''}`}
              title={(ICON_LIB[k] as { displayName?: string })?.displayName ?? k}
              onClick={() => onUpdateMeta(item.taskId, { icon: k })}
            >
              <ItemIcon name={k} size={20} />
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div
        className="mono"
        style={{
          fontSize: 9,
          color: 'var(--ink-4)',
          letterSpacing: '.08em',
          lineHeight: 1.7,
        }}
      >
        BURNS {invRateLabel(inv)} · VERIFIED {inv.count} ON{' '}
        {invDateLabel(inv.verified)} · EST {invFmt(est)} TODAY · RUNS OUT{' '}
        {invRunout(inv)}
      </div>

      {/* Danger zone */}
      <div className="inv-danger">
        {confirmDel ? (
          <div className="inv-danger-confirm">
            <span className="mono up-s warn-txt">REMOVE "{item.name}" PERMANENTLY?</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn danger" style={{ flex: 1, justifyContent: 'center' }} onClick={() => onDelete(item.taskId)}>DELETE</button>
              <button className="btn ghost" onClick={() => setConfirmDel(false)}>CANCEL</button>
            </div>
          </div>
        ) : (
          <button className="btn ghost inv-danger-btn" onClick={() => setConfirmDel(true)}>REMOVE ITEM</button>
        )}
      </div>
    </div>
  );
}

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

// ─── AddSupplyForm ────────────────────────────────────────────────────────────

interface AddSupplyFormProps {
  cardId: string;
  items: ItemWithMeta[];
  gridCols: number;
  gridRows: number;
  onDone: () => void;
}

function AddSupplyForm({ cardId, items, gridCols, gridRows, onDone }: AddSupplyFormProps) {
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
  const { invDisplay } = useSettings();

  const [sel, setSel] = useState<string | null>(null);
  const [showVer, setShowVer] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [qaOpen, setQaOpen] = useState(false);
  // Incrementing counter used to force a re-render when posOverridesRef changes.
  const [, setPosOverrideTick] = useState(0);

  // Per-item debounce timers for position persist (key = taskId)
  const debounceMapRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Optimistic local position overrides: { [taskId]: { x, y } }
  // Cleared when the query re-fetches (items derived from fresh data will match).
  const posOverridesRef = useRef<Map<string, { x: number; y: number }>>(new Map());

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
      return {
        taskId: t.id,
        name: t.content,
        inv: over ? { ...base, x: over.x, y: over.y } : base,
      };
    });

  const { cols, rows } = gridDims(items);
  const alerts = items.filter((i) => invStatus(i.inv) !== 'ok').length;
  const selItem = items.find((i) => i.taskId === sel) ?? null;
  const cardTasks = cardTasksQuery.data ?? [];

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
        <ViewHead card={card} items={[]} alerts={0} cols={cols} rows={rows} />
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
        <ViewHead card={card} items={[]} alerts={0} cols={cols} rows={rows} />
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
        <ViewHead card={card} items={[]} alerts={0} cols={6} rows={3} />
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
      <ViewHead card={card} items={items} alerts={alerts} cols={cols} rows={rows} />
      <CharterPanel card={card} />

      <div className="bespoke">
        {/* Stage */}
        <div className="stage">
          <span className="tick-c tl" />
          <span className="tick-c tr" />
          <span className="tick-c bl" />
          <span className="tick-c br" />

          <div className="stage-head">
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
          </div>

          <div className="inv-wrap">
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
          </div>

          {/* Footer row with add supply */}
          <div className="stage-foot">
            <span>FORMAT · INVENTORY v2</span>
            <span>HOVER FOR NAME</span>
            <span>
              {showAddForm ? (
                <AddSupplyForm
                  cardId={card.id}
                  items={items}
                  gridCols={cols}
                  gridRows={rows}
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
}: {
  card: CardDef;
  items: ItemWithMeta[];
  alerts: number;
  cols: number;
  rows: number;
}) {
  return (
    <div className="view-head">
      <div>
        <div className="kicker mono up">
          <span className="tick" />
          CARD · {card.category} · SUPPLY GRID ◆
        </div>
        <div className="view-title">{card.name}</div>
        <div className="view-sub mono" style={{ fontSize: 11 }}>
          {items.length} supplies tracked · estimates live
        </div>
      </div>
      <div className="head-meta">
        <div className={`big${alerts > 0 ? ' coral' : ''}`}>{alerts}</div>
        <div className="mono up" style={{ fontSize: 9.5, marginTop: 6 }}>
          RESTOCK ALERTS · {cols}×{rows} GRID
        </div>
      </div>
    </div>
  );
}
