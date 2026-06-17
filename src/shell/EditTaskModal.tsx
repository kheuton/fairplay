/**
 * FAIRPLAY · EditTask modal (desktop).
 * ──────────────────────────────────────────────────────────────────────────
 * Edit an existing task's name and due/recurrence, with a two-step delete.
 * Mirrors QuickAdd's chrome and reuses the same .qa-* / RecurPicker / .btn styles.
 *
 * Correctness notes (see useUpdateTask in lib/todoist/hooks.ts):
 *   • We send ONLY `content` and (when it changed) `due`. We never send
 *     description/meta — useUpdateTask preserves the server-side FP:: metadata
 *     line as long as the patch leaves description+meta out.
 *   • `due` is sent ONLY when it differs from the task's current due string, so
 *     renaming a recurring task does NOT make Todoist recompute / shift its next
 *     occurrence. The free-text string round-trips recurrence faithfully, so
 *     fixing an accidental recurrence = edit it to a one-off date (or clear it).
 */
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDeck, useUpdateTask, useDeleteItem } from '../lib/todoist/hooks';
import type { FpTask } from '../lib/types';
import { RecurPicker } from './RecurPicker';

/** Case/whitespace-insensitive compare so a re-touched-but-unchanged due isn't resent. */
const normalizeDue = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

interface EditTaskModalProps {
  /** Task being edited, or null when closed. */
  task: FpTask | null;
  onClose: () => void;
}

export function EditTaskModal({ task, onClose }: EditTaskModalProps) {
  const { data: deck = [] } = useDeck();
  const navigate = useNavigate();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteItem();

  const [content, setContent] = useState('');
  const [due, setDue] = useState('');
  const [dueTouched, setDueTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const contentRef = useRef<HTMLInputElement>(null);

  // Seed the form whenever a (different) task is opened.
  useEffect(() => {
    if (!task) return;
    setContent(task.content);
    setDue(task.due?.string ?? '');
    setDueTouched(false);
    setError(null);
    setConfirmDelete(false);
    const t = window.setTimeout(() => contentRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [task?.id]);

  // Escape closes while open.
  useEffect(() => {
    if (!task) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [task, onClose]);

  if (!task) return null;
  // Capture the non-null task so handler closures keep the narrowed type.
  const editing = task;

  const card = deck.find((c) => c.id === editing.cardId);
  const origDue = editing.due?.string ?? '';
  const canSubmit = content.trim().length > 0;
  const busy = updateTask.isPending || deleteTask.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const name = content.trim();
    if (!name) return;
    const nextDue = due.trim();
    const patch: { content: string; due?: string | null } = { content: name };
    // Only touch due when the user actually changed the due/recurrence control. A
    // pure rename must NOT make Todoist recompute a recurring task's next occurrence,
    // and the RecurPicker re-emits a non-canonical string ("every mon" vs Todoist's
    // "every Monday"), so we cannot rely on string equality alone — gate on dueTouched.
    if (dueTouched && normalizeDue(nextDue) !== normalizeDue(origDue)) {
      patch.due = nextDue ? nextDue : null;
    }
    updateTask.mutate(
      { id: editing.id, patch },
      {
        onSuccess: () => onClose(),
        onError: (err: Error) => setError(err.message ?? 'FAILED TO SAVE'),
      }
    );
  }

  function handleDelete() {
    setError(null);
    if (!confirmDelete) { setConfirmDelete(true); return; }
    deleteTask.mutate(editing.id, {
      onSuccess: () => onClose(),
      onError: (err: Error) => setError(err.message ?? 'FAILED TO DELETE'),
    });
  }

  return (
    <div className="qa-backdrop" onClick={onClose}>
      <div
        className="qa-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-label="Edit Task"
      >
        <div className="qa-header">
          <span className="mono up">EDIT TASK</span>
          <button className="qa-close mono" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form onSubmit={handleSubmit} className="qa-form">
          {/* Task name */}
          <div className="qa-field">
            <label className="qa-label mono up-s">TASK NAME</label>
            <input
              ref={contentRef}
              className="qa-input"
              placeholder="What needs to happen..."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              autoComplete="off"
            />
          </div>

          {/* Card — read-only (no cross-card moves here), but clickable to open the
              card view, since clicking an inbox row now edits instead of navigating. */}
          {card && (
            <div className="qa-field">
              <label className="qa-label mono up-s">CARD</label>
              <button
                type="button"
                className="qa-input qa-locked mono up-s"
                style={{ cursor: 'pointer', width: '100%', justifyContent: 'space-between', textAlign: 'left' }}
                title="Open this card"
                onClick={() => { onClose(); navigate(`/card/${card.id}`); }}
              >
                <span>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      display: 'inline-block',
                      background: card.color ?? 'var(--ink-4)',
                      marginRight: 9,
                      verticalAlign: 'middle',
                    }}
                  />
                  {card.name}
                </span>
                <span style={{ color: 'var(--ink-3)' }}>VIEW →</span>
              </button>
            </div>
          )}

          {/* Due / repeat */}
          <div className="qa-field">
            <label className="qa-label mono up-s">DUE / REPEAT</label>
            <RecurPicker value={due} onChange={(v) => { setDue(v); setDueTouched(true); }} />
          </div>

          {/* Error */}
          {error && <div className="qa-error mono up-s">{error}</div>}

          {/* Actions: Delete on the left, Cancel/Save on the right */}
          <div className="qa-actions">
            <button
              type="button"
              className="btn danger"
              style={{ marginRight: 'auto' }}
              onClick={handleDelete}
              disabled={busy}
            >
              {deleteTask.isPending ? 'DELETING...' : confirmDelete ? 'CONFIRM DELETE' : 'DELETE'}
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>
              CANCEL
            </button>
            <button type="submit" className="btn coral" disabled={!canSubmit || busy}>
              {updateTask.isPending ? 'SAVING...' : 'SAVE'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
