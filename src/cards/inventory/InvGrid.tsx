/**
 * FAIRPLAY · InvGrid
 * RE4-style supply grid: drag-to-rearrange, fixed cell layout.
 * Extracted from InventoryView for reuse on desktop and mobile.
 */
import React, { useCallback, useRef, useState } from 'react';
import type { InvMeta } from '../../lib/types';
import { invEst, invStatus, invFmt, invRunout } from '../../lib/inventory-math';
import { ItemIcon } from '../../shell/icons';
import type { ItemWithMeta } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

export const INV_CELL = 64;

// ─── DragState ────────────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Find first free 1x1 slot in a cols×rows grid given occupied items. */
export function firstFreeSlot(
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
export function gridDims(items: ItemWithMeta[]): { cols: number; rows: number } {
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

export function InvGrid({
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
