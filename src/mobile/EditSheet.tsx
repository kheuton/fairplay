/**
 * FAIRPLAY · Edit-task bottom sheet (mobile).
 * ──────────────────────────────────────────────────────────────────────────
 * Opened by tapping a task row or swiping it RIGHT (the opposite of swipe-left =
 * done). Edits name + due/recurrence and offers a two-step delete. Mirrors
 * AddSheet's chrome (.m-backdrop / .m-sheet / .m-input / .m-chips) but writes via
 * useUpdateTask.
 *
 * Due is a free-text Todoist natural-language string prefilled from
 * task.due.string, so an existing recurrence ("every monday") round-trips
 * faithfully and an accidental recurrence is fixed by editing/clearing it. We send
 * `due` only when it changed (so a rename doesn't reschedule a recurring task) and
 * never send description/meta (preserving the FP:: metadata line).
 */
import React, { useEffect, useRef, useState } from 'react';
import { useUpdateTask, useDeleteItem } from '../lib/todoist/hooks';
import type { FpTask } from '../lib/types';
import { Ic } from './icons';

/** Case/whitespace-insensitive compare so a re-touched-but-unchanged due isn't resent. */
const normalizeDue = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

interface EditSheetProps {
  /** Task being edited, or null when the sheet is closed. */
  task: FpTask | null;
  onClose: () => void;
}

/** Quick-set chips that write the due text field. '' = no date. */
const DUE_PRESETS: [label: string, val: string][] = [
  ['Today', 'today'],
  ['Tomorrow', 'tomorrow'],
  ['Every day', 'every day'],
  ['No date', ''],
];

export function EditSheet({ task, onClose }: EditSheetProps) {
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteItem();

  const [name, setName] = useState('');
  const [due, setDue] = useState('');
  const [dueTouched, setDueTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const open = task !== null;

  // Seed + focus when a (different) task opens, after the slide-up.
  useEffect(() => {
    if (!task) return;
    setName(task.content);
    setDue(task.due?.string ?? '');
    setDueTouched(false);
    setError(null);
    setConfirmDelete(false);
    const t = window.setTimeout(() => nameRef.current?.focus(), 320);
    return () => window.clearTimeout(t);
  }, [task?.id]);

  // Escape closes while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const origDue = task?.due?.string ?? '';
  const busy = updateTask.isPending || deleteTask.isPending;
  const canSubmit = name.trim().length > 0 && !busy;

  const submit = () => {
    if (!task || busy) return;
    setError(null);
    const content = name.trim();
    if (!content) return;
    const nextDue = due.trim();
    const patch: { content: string; due?: string | null } = { content };
    // Only touch due when the user actually edited the due field/chips, so a pure
    // rename never reschedules a recurring task. (See EditTaskModal for the why.)
    if (dueTouched && normalizeDue(nextDue) !== normalizeDue(origDue)) {
      patch.due = nextDue ? nextDue : null;
    }
    updateTask.mutate(
      { id: task.id, patch },
      {
        onSuccess: () => onClose(),
        onError: (err: Error) => setError(err.message || 'FAILED TO SAVE'),
      }
    );
  };

  const remove = () => {
    if (!task) return;
    setError(null);
    if (!confirmDelete) { setConfirmDelete(true); return; }
    deleteTask.mutate(task.id, {
      onSuccess: () => onClose(),
      onError: (err: Error) => setError(err.message || 'FAILED TO DELETE'),
    });
  };

  return (
    <>
      <div className={`m-backdrop${open ? ' show' : ''}`} onClick={onClose} />
      <div
        className={`m-sheet${open ? ' show' : ''}`}
        role="dialog"
        aria-modal
        aria-label="Edit task"
        aria-hidden={!open}
      >
        <div className="m-sheet-grab" />
        <div className="m-sheet-h">
          <span className="t">Edit task</span>
          <button className="x mono" onClick={onClose}>
            CLOSE
          </button>
        </div>

        <input
          ref={nameRef}
          className="m-input"
          value={name}
          placeholder="What needs doing?"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />

        <div className="m-field-l">Due / repeat</div>
        <input
          className="m-input"
          value={due}
          placeholder="e.g. tomorrow, every monday"
          onChange={(e) => { setDue(e.target.value); setDueTouched(true); }}
          autoComplete="off"
        />
        <div className="m-chips" style={{ marginTop: 10 }}>
          {DUE_PRESETS.map(([label, val]) => (
            <button
              key={label}
              className={`m-chip${normalizeDue(due) === val ? ' on' : ''}`}
              onClick={() => { setDue(val); setDueTouched(true); }}
            >
              {label}
            </button>
          ))}
        </div>

        {error && <div className="m-sheet-err">{error}</div>}

        <button className="m-sheet-add" disabled={!canSubmit} onClick={submit}>
          {Ic.check({ s: 16, c: 'currentColor' })} {updateTask.isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button className="m-sheet-del" disabled={busy} onClick={remove}>
          {deleteTask.isPending ? 'Deleting…' : confirmDelete ? 'Tap again to delete' : 'Delete task'}
        </button>
      </div>
    </>
  );
}
