/**
 * FAIRPLAY · Add-task bottom sheet (opened by the FAB).
 * Wired to the real useCreateTask. Fields: name, card (chips unless pre-filled
 * from a card screen), When, Repeat.
 *
 * NOTE: there is no per-task "owner" in the data model — a task belongs to a
 * deck (= the active profile). So the task is created in the ACTIVE owner's deck;
 * we intentionally omit the prototype's Owner chips (cross-deck creation isn't a
 * thing here).
 *
 * When/Repeat → Todoist natural-language due string:
 *   Repeat wins when set: Daily→"every day", Weekly→"every week", Monthly→"every month".
 *   Otherwise: Today→"today", This week→"in 5 days", Later→undated.
 */
import React, { useEffect, useRef, useState } from 'react';
import { useDeck, useCreateTask } from '../lib/todoist/hooks';
import { Ic } from './icons';

type When = 'today' | 'week' | 'later';
type Repeat = '' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

function toDueString(when: When, repeat: Repeat): string | undefined {
  if (repeat === 'DAILY') return 'every day';
  if (repeat === 'WEEKLY') return 'every week';
  if (repeat === 'MONTHLY') return 'every month';
  if (when === 'today') return 'today';
  if (when === 'week') return 'in 5 days';
  return undefined; // later / undated
}

interface AddSheetProps {
  open: boolean;
  /** Preset card (FAB tapped on a card screen) or null to pick one. */
  presetCardId: string | null;
  onClose: () => void;
}

export function AddSheet({ open, presetCardId, onClose }: AddSheetProps) {
  const { data: deck = [] } = useDeck();
  const createTask = useCreateTask();

  const [name, setName] = useState('');
  const [cardId, setCardId] = useState('');
  const [when, setWhen] = useState<When>('today');
  const [repeat, setRepeat] = useState<Repeat>('');
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Reset + focus when the sheet opens (after the slide-up).
  useEffect(() => {
    if (!open) return;
    setName('');
    setCardId(presetCardId ?? '');
    setWhen('today');
    setRepeat('');
    setError(null);
    const t = window.setTimeout(() => nameRef.current?.focus(), 320);
    return () => window.clearTimeout(t);
  }, [open, presetCardId]);

  // Escape closes the sheet while it's open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const presetCard = presetCardId ? deck.find((c) => c.id === presetCardId) : undefined;
  const canSubmit = name.trim().length > 0 && cardId.length > 0 && !createTask.isPending;

  const submit = () => {
    setError(null);
    if (!name.trim()) return;
    if (!cardId) {
      setError('SELECT A CARD');
      return;
    }
    createTask.mutate(
      { content: name.trim(), cardId, due: toDueString(when, repeat) },
      {
        onSuccess: () => onClose(),
        onError: (err: Error) => setError(err.message || 'FAILED TO CREATE TASK'),
      }
    );
  };

  const whenOpts: [When, string][] = [
    ['today', 'Today'],
    ['week', 'This week'],
    ['later', 'Later'],
  ];
  const repeatOpts: [Repeat, string][] = [
    ['', 'Once'],
    ['DAILY', 'Daily'],
    ['WEEKLY', 'Weekly'],
    ['MONTHLY', 'Monthly'],
  ];

  return (
    <>
      <div className={`m-backdrop${open ? ' show' : ''}`} onClick={onClose} />
      <div className={`m-sheet${open ? ' show' : ''}`} role="dialog" aria-modal aria-label="Add task" aria-hidden={!open}>
        <div className="m-sheet-grab" />
        <div className="m-sheet-h">
          <span className="t">New task</span>
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

        <div className="m-field-l">Card</div>
        {presetCard ? (
          <div className="m-chips">
            <span className="m-chip on" style={{ cursor: 'default' }}>
              <span className="sw" style={{ background: presetCard.color ?? 'var(--ink-4)' }} />
              {presetCard.name}
            </span>
          </div>
        ) : (
          <div className="m-chips">
            {deck.map((c) => (
              <button
                key={c.id}
                className={`m-chip${cardId === c.id ? ' on' : ''}`}
                onClick={() => setCardId(c.id)}
              >
                <span className="sw" style={{ background: c.color ?? 'var(--ink-4)' }} />
                {c.name}
              </button>
            ))}
          </div>
        )}

        <div className="m-field-l">When{repeat !== '' ? ' · set by repeat' : ''}</div>
        <div className="m-chips">
          {whenOpts.map(([v, l]) => (
            <button
              key={v}
              className={`m-chip${when === v && repeat === '' ? ' on' : ''}`}
              disabled={repeat !== ''}
              onClick={() => setWhen(v)}
            >
              {l}
            </button>
          ))}
        </div>

        <div className="m-field-l">Repeat</div>
        <div className="m-chips">
          {repeatOpts.map(([v, l]) => (
            <button key={l} className={`m-chip ok${repeat === v ? ' on' : ''}`} onClick={() => setRepeat(v)}>
              {l}
            </button>
          ))}
        </div>

        {error && <div className="m-sheet-err">{error}</div>}

        <button className="m-sheet-add" disabled={!canSubmit} onClick={submit}>
          {Ic.plus({ s: 16, c: 'currentColor' })} {createTask.isPending ? 'Adding…' : 'Add task'}
        </button>
      </div>
    </>
  );
}
