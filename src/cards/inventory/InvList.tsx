/**
 * FAIRPLAY · InvList
 * Reorderable supply list shared by desktop and mobile views.
 * Items are displayed in the order they are GIVEN (pre-sorted by caller).
 * Reorder is grip-initiated only (touch + mouse) via pointer capture.
 * No "/stack" shown — list mode is unlimited-items, no cap display.
 */
import React, { useRef, useState } from 'react';
import {
  invEst,
  invStatus,
  invFmt,
  invDateLabel,
  invRunout,
  invRateLabel,
  invChip,
} from '../../lib/inventory-math';
import { ItemIcon } from '../../shell/icons';
import type { ItemWithMeta } from './types';
import './inventory.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RowRect {
  id: string;
  top: number;
  mid: number;
  height: number;
}

interface DragState {
  dragId: string;
  startY: number;
  workingIds: string[];
  dy: number;
  rowRects: RowRect[];
}

// ─── InvList ──────────────────────────────────────────────────────────────────

interface InvListProps {
  items: ItemWithMeta[];
  selId: string | null;
  onSelect: (id: string | null) => void;
  onReorder: (orderedIds: string[]) => void;
  variant?: 'desktop' | 'mobile';
}

export function InvList({ items, selId, onSelect, onReorder, variant = 'desktop' }: InvListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  // Render order: when dragging use workingIds to reflect live reorder; else use items
  const renderIds = drag ? drag.workingIds : items.map((i) => i.taskId);
  const itemById = new Map(items.map((i) => [i.taskId, i]));

  const handleGripPointerDown = (e: React.PointerEvent, dragId: string) => {
    // Both mouse (button 0) and touch (button -1) are allowed
    if (e.button !== 0 && e.button !== -1) return;
    if (items.length < 2) return;

    // Capture pointer on the grip element
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.stopPropagation();

    const container = containerRef.current;
    if (!container) return;

    const snapshot = items.map((i) => i.taskId);

    // Measure row rects from container children at the time of grab
    const children = Array.from(container.children) as HTMLElement[];
    const rowRects: RowRect[] = [];
    children.forEach((child, idx) => {
      const rect = child.getBoundingClientRect();
      rowRects.push({
        id: snapshot[idx],
        top: rect.top,
        mid: rect.top + rect.height / 2,
        height: rect.height,
      });
    });

    setDrag({
      dragId,
      startY: e.clientY,
      workingIds: [...snapshot],
      dy: 0,
      rowRects,
    });
  };

  const handleGripPointerMove = (e: React.PointerEvent) => {
    setDrag((d) => {
      if (!d) return d;

      const dy = e.clientY - d.startY;

      // Find which row the pointer is over using ORIGINAL measured midpoints
      const pointerY = e.clientY;
      let targetIdx = d.workingIds.indexOf(d.dragId);
      for (let i = 0; i < d.rowRects.length; i++) {
        if (pointerY < d.rowRects[i].mid) {
          targetIdx = i;
          break;
        }
        // If pointer is below the last midpoint, clamp to last
        targetIdx = i;
      }
      targetIdx = Math.max(0, Math.min(d.workingIds.length - 1, targetIdx));

      // rowRects index space is the ORIGINAL layout; workingIds has already been
      // live-reordered on prior moves. Map the original slot back to the live array
      // position via the row that originally occupied it, so fast drags across
      // several boundaries land in the right slot.
      const anchorId = d.rowRects[targetIdx]?.id;
      if (anchorId && anchorId !== d.dragId) {
        const anchorCurrent = d.workingIds.indexOf(anchorId);
        if (anchorCurrent !== -1) targetIdx = anchorCurrent;
      }

      const currentIdx = d.workingIds.indexOf(d.dragId);
      if (targetIdx === currentIdx) {
        return { ...d, dy };
      }

      // Splice-move dragId to targetIdx
      const next = [...d.workingIds];
      next.splice(currentIdx, 1);
      next.splice(targetIdx, 0, d.dragId);

      return { ...d, dy, workingIds: next };
    });
  };

  const handleGripPointerUp = (e: React.PointerEvent) => {
    if (!drag) return;

    const snapshot = items.map((i) => i.taskId);
    const changed =
      drag.workingIds.length === snapshot.length &&
      drag.workingIds.some((id, idx) => id !== snapshot[idx]);

    // `changed` (workingIds differs from the snapshot) is the complete guard — a
    // boundary can be crossed with only a few px of travel, so don't also gate on dy.
    if (changed) {
      onReorder(drag.workingIds);
    }

    setDrag(null);
    e.stopPropagation();
  };

  return (
    <div
      className={`inv-list${variant === 'mobile' ? ' mobile' : ''}`}
      ref={containerRef}
      onPointerMove={handleGripPointerMove}
      onPointerUp={handleGripPointerUp}
      onPointerCancel={handleGripPointerUp}
    >
      {renderIds.map((id) => {
        const item = itemById.get(id);
        if (!item) return null;

        const { inv } = item;
        const est = invEst(inv);
        const status = invStatus(inv);
        const sel = selId === item.taskId;
        const dragging = !!(drag && drag.dragId === item.taskId);

        return (
          <div
            key={item.taskId}
            className={`inv-row ${status}${sel ? ' sel' : ''}${dragging ? ' dragging' : ''}`}
            style={dragging ? { transform: `translateY(${drag!.dy}px)`, zIndex: 30 } : undefined}
          >
            {/* Grip — reorder starts ONLY here; move/up/cancel are handled on the
                container (always mounted, so no first-frame registration gap, and
                pointer capture on the grip still routes events there to bubble up). */}
            <div
              className="inv-row-grip"
              onPointerDown={(e) => handleGripPointerDown(e, item.taskId)}
            >
              ⋮⋮
            </div>

            {/* Icon */}
            <ItemIcon name={inv.icon} size={22} />

            {/* Middle: name + sub */}
            <div
              className="inv-row-mid"
              onClick={() => onSelect(sel ? null : item.taskId)}
            >
              <div className="inv-row-name">{item.name}</div>
              <div className="inv-row-sub mono">
                ✓{inv.count} {invDateLabel(inv.verified)} · {invRateLabel(inv)}
              </div>
            </div>

            {/* Right cluster: est, chip, runout */}
            <div
              className="inv-row-right"
              onClick={() => onSelect(sel ? null : item.taskId)}
            >
              <div className="inv-row-est mono">{invFmt(est)}</div>
              <span className={`chip ${status}`}>{invChip(inv)}</span>
              <div className="inv-row-out mono">
                {status === 'out' ? 'OUT NOW' : `OUT ${invRunout(inv)}`}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
