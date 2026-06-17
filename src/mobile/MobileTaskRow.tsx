/**
 * FAIRPLAY · MobileTaskRow — swipe-to-complete (no checkbox).
 * ──────────────────────────────────────────────────────────────────────────
 * Ported from the mobile prototype's swipeable TaskRow:
 *   - axis is decided after 6px of movement; vertical gestures fall through to
 *     scroll (touch-action: pan-y), horizontal gestures capture the pointer;
 *   - the row rubber-bands when dragged the wrong way and clamps at -rowWidth;
 *   - past the 96px threshold it animates fully out, then fires onToggle.
 * The current translate is mirrored in a ref so the release handler reads the
 * live value (not a stale render closure).
 *
 * onToggle maps to useCloseTask (open rows) or useReopenTask (done rows) at the
 * call site. Reduced motion is honored via mobile.css (transitions disabled).
 */
import React, { useRef, useState, useEffect } from 'react';
import type { FpTask, CardDef } from '../lib/types';
import { dueLabel } from '../lib/format';
import { Ic } from './icons';

const THRESHOLD = 96;

interface MobileTaskRowProps {
  task: FpTask;
  /** Card the task belongs to — used for the colored tag. */
  card?: CardDef;
  /** Show the card tag (true in the Inbox where cards are mixed). */
  showTag?: boolean;
  /** This is a completed row (Done screen) — swipe reopens instead of completes. */
  done?: boolean;
  onToggle: () => void;
  /** Open the editor (tap, or swipe RIGHT). Omit to disable editing for this row. */
  onEdit?: () => void;
}

export function MobileTaskRow({ task, card, showTag = false, done = false, onToggle, onEdit }: MobileTaskRowProps) {
  const [tx, setTx] = useState(0);
  const [settle, setSettle] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Whether the current/last drag is a rightward EDIT reveal. Sticky through the
  // settle-back so the behind layer keeps its dark EDIT styling instead of flashing
  // the green DONE bar while the row animates home; reset when a new gesture starts.
  const [swipeEdit, setSwipeEdit] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const txRef = useRef(0);
  const st = useRef({ x: 0, y: 0, w: 0, drag: false, decided: false, swipe: false });
  const timeoutRef = useRef<number | null>(null);

  const clearPending = () => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };
  // Cancel a pending completion timeout if the row unmounts mid-animation.
  useEffect(() => clearPending, []);

  const dl = dueLabel(task);
  const isRecurring = task.due?.isRecurring ?? false;
  const showMeta = (showTag && !!card) || (isRecurring && !!task.due?.string);
  // Editing is offered on open rows only (not the Done screen).
  const editable = !!onEdit && !done;
  // Right-drag reveals the EDIT affordance instead of DONE/REOPEN.
  const showEdit = editable && swipeEdit;

  const applyTx = (v: number) => {
    txRef.current = v;
    setTx(v);
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    clearPending(); // a fresh gesture cancels any in-flight completion settle
    const r = rowRef.current?.getBoundingClientRect();
    st.current = { x: e.clientX, y: e.clientY, w: r?.width ?? 0, drag: true, decided: false, swipe: false };
    setSettle(false);
    setSwipeEdit(false);
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = st.current;
    if (!s.drag) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.decided) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      s.decided = true;
      s.swipe = Math.abs(dx) > Math.abs(dy);
      if (s.swipe) {
        setDragging(true);
        try { rowRef.current?.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
      }
    }
    if (!s.swipe) return;
    let nx = dx;
    // Leftward = complete/reopen. Rightward = edit (only when editable); otherwise
    // rubber-band the wrong-way drag so it reads as a no-op.
    if (nx > 0 && !editable) nx = nx * 0.25;
    const hi = editable ? s.w : Infinity;
    applyTx(Math.max(-s.w, Math.min(hi, nx)));
    // Track direction so the behind layer shows EDIT (right) vs DONE (left), and
    // keeps showing it through the settle-back (see swipeEdit).
    setSwipeEdit(editable && nx > 0);
  };

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = st.current;
    if (!s.drag) return;
    s.drag = false;
    setDragging(false);
    setSettle(true);
    if (s.swipe && txRef.current < -THRESHOLD) {
      // Swipe LEFT past threshold → complete / reopen (animate fully off, then fire).
      applyTx(-s.w);
      clearPending();
      timeoutRef.current = window.setTimeout(() => {
        timeoutRef.current = null;
        onToggle();
        applyTx(0);
      }, 180);
    } else if (editable && s.swipe && txRef.current > THRESHOLD) {
      // Swipe RIGHT past threshold → edit. Non-destructive: settle back to 0 (the
      // EDIT reveal stays via swipeEdit), then open the editor.
      applyTx(0);
      onEdit?.();
    } else if (editable && !s.decided && e.type !== 'pointercancel') {
      // Genuine TAP: never crossed the 6px axis deadzone AND the pointer was lifted
      // (not a native scroll, which ends in pointercancel). Detected via gesture
      // state rather than a separate onClick, which would double-fire after a swipe.
      applyTx(0);
      onEdit?.();
    } else {
      applyTx(0);
    }
  };

  return (
    <div className="m-task-wrap">
      <div className={`m-task-behind${showEdit ? ' edit' : ''}`}>
        {showEdit ? 'EDIT' : done ? 'REOPEN' : 'DONE'}
        <span className="ck">
          {showEdit
            ? Ic.edit({ s: 16, c: 'var(--bg)' })
            : Ic.check({ s: 17, c: 'var(--accent-ink)' })}
        </span>
      </div>
      <div
        ref={rowRef}
        className={`m-task${done ? ' done' : ''}${settle ? ' settle' : ''}${dragging ? ' dragging' : ''}`}
        style={{ transform: `translateX(${tx}px)` }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <div className="m-tbody">
          <div className="m-tname">{task.content}</div>
          {showMeta && (
            <div className="m-tmeta">
              {showTag && card && (
                <span className="m-tag">
                  <span className="sw" style={{ background: card.color ?? 'var(--ink-4)' }} />
                  {card.name}
                </span>
              )}
              {isRecurring && task.due?.string && (
                <span className="m-recur">⟳ {task.due.string.toUpperCase()}</span>
              )}
            </div>
          )}
        </div>
        {!done && task.due && (
          <div className="m-trail">
            <span className={`m-due${dl.over ? ' over' : ''}`}>{dl.main}</span>
          </div>
        )}
      </div>
    </div>
  );
}
