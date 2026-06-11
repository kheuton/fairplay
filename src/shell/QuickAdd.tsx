/**
 * FAIRPLAY · QuickAdd modal.
 * Mono-styled, square corners. Escape/backdrop close.
 * Card select from useDeck in deck order (preset+locked when presetCardId given).
 * Natural-language due input. Error surface on failure.
 */
import React, { useState, useEffect, useRef } from 'react';
import { useDeck, useCreateTask } from '../lib/todoist/hooks';
import type { CardDef } from '../lib/types';

interface QuickAddProps {
  open: boolean;
  onClose: () => void;
  presetCardId?: string;
}

export function QuickAdd({ open, onClose, presetCardId }: QuickAddProps) {
  const { data: deck = [] } = useDeck();
  const createTask = useCreateTask();

  const [content, setContent] = useState('');
  const [cardId, setCardId] = useState(presetCardId ?? '');
  const [due, setDue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const contentRef = useRef<HTMLInputElement>(null);

  // Reset state when opened
  useEffect(() => {
    if (open) {
      setContent('');
      setDue('');
      setError(null);
      setCardId(presetCardId ?? '');
      // Focus content input after mount
      setTimeout(() => contentRef.current?.focus(), 50);
    }
  }, [open, presetCardId]);

  // Escape key closes
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!content.trim()) return;
    if (!cardId) { setError('SELECT A CARD'); return; }

    createTask.mutate(
      { content: content.trim(), cardId, due: due.trim() || undefined },
      {
        onSuccess: () => {
          setContent('');
          setDue('');
          onClose();
        },
        onError: (err: Error) => {
          setError(err.message ?? 'FAILED TO CREATE TASK');
        },
      }
    );
  }

  const presetCard: CardDef | undefined = presetCardId
    ? deck.find((c) => c.id === presetCardId)
    : undefined;

  const canSubmit = content.trim().length > 0 && cardId.length > 0;

  return (
    <div
      className="qa-backdrop"
      onClick={onClose}
    >
      <div
        className="qa-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        aria-label="Add Task"
      >
        {/* Header */}
        <div className="qa-header">
          <span className="mono up">ADD TASK</span>
          <button
            className="qa-close mono"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
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

          {/* Card select */}
          <div className="qa-field">
            <label className="qa-label mono up-s">CARD</label>
            {presetCard ? (
              <div className="qa-input qa-locked mono up-s">
                <span
                  style={{
                    width: 8,
                    height: 8,
                    display: 'inline-block',
                    background: presetCard.color ?? 'var(--ink-4)',
                    marginRight: 9,
                    verticalAlign: 'middle',
                  }}
                />
                {presetCard.name}
              </div>
            ) : (
              <select
                className="qa-select"
                value={cardId}
                onChange={(e) => setCardId(e.target.value)}
              >
                <option value="">SELECT CARD...</option>
                {deck.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Due */}
          <div className="qa-field">
            <label className="qa-label mono up-s">DUE</label>
            <input
              className="qa-input mono"
              placeholder="tomorrow 8pm, every friday..."
              value={due}
              onChange={(e) => setDue(e.target.value)}
              autoComplete="off"
            />
          </div>

          {/* Error */}
          {error && (
            <div className="qa-error mono up-s">{error}</div>
          )}

          {/* Actions */}
          <div className="qa-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={onClose}
            >
              CANCEL
            </button>
            <button
              type="submit"
              className="btn coral"
              disabled={!canSubmit || createTask.isPending}
            >
              {createTask.isPending ? 'ADDING...' : 'ADD TASK'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
