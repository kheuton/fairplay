/**
 * FAIRPLAY · CharterPanel
 * Thin full-width strip under the view-head that expands into the
 * Card Charter editor (MSC + CPE fields). Shared across all five card views.
 *
 * Props: { card: CardDef }
 *
 * Collapsed (default): hairline strip, '▸ CHARTER · MSC + CPE', revised date or 'UNSET'.
 *   When concept tasks are detected: shows 'N CONCEPT TASKS · ABSORB ▸' chip.
 * Expanded: two-column panel; left = MSC, right = CPE fields stacked.
 *   Each field: rendered text or 'NOT SET — CLICK TO DEFINE'; click → inline textarea.
 *   Absorb chip click → confirm strip listing matched task names.
 */
import React, { useState } from 'react';
import type { CardDef } from '../lib/types';
import {
  useCardTasks,
  useCharter,
  useAbsorbCharter,
  type CharterFields,
} from '../lib/todoist/hooks';
import { detectConceptTasks } from '../lib/charter';
import { useConnection } from '../lib/todoist/hooks';
import { format, parseISO } from 'date-fns';
import './charter.css';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  card: CardDef;
}

type FieldKey = keyof CharterFields;

const FIELD_LABELS: Record<FieldKey, string> = {
  msc:        'MINIMUM STANDARD OF CARE',
  conception: 'CONCEPTION',
  planning:   'PLANNING',
  execution:  'EXECUTION',
};

// ─── CharterField ─────────────────────────────────────────────────────────────

interface CharterFieldProps {
  fieldKey: FieldKey;
  value: string;
  readonly: boolean;
  onSave: (newValue: string) => void;
  /** If true the field grows taller (MSC). */
  large?: boolean;
}

function CharterField({ fieldKey, value, readonly, onSave, large }: CharterFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const isEmpty = !value.trim();

  function startEdit() {
    if (readonly) return;
    setDraft(value);
    setEditing(true);
  }

  function handleSave() {
    onSave(draft);
    setEditing(false);
  }

  function handleCancel() {
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  }

  return (
    <div className="charter-field">
      <div className="charter-field-label mono up">{FIELD_LABELS[fieldKey]}</div>

      {editing ? (
        <>
          <textarea
            className="charter-textarea"
            style={large ? { minHeight: 110 } : {}}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label={`Edit ${FIELD_LABELS[fieldKey]}`}
          />
          <div className="charter-field-actions">
            <button
              className="btn coral"
              style={{ fontSize: 9, padding: '5px 10px' }}
              onClick={handleSave}
            >
              SAVE
            </button>
            <button
              className="btn ghost"
              style={{ fontSize: 9, padding: '5px 10px' }}
              onClick={handleCancel}
            >
              CANCEL
            </button>
          </div>
        </>
      ) : (
        <div
          className={[
            'charter-field-body',
            isEmpty ? 'empty' : '',
            readonly ? 'readonly' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={large ? { minHeight: 110 } : {}}
          onClick={startEdit}
          role={readonly ? undefined : 'button'}
          tabIndex={readonly ? undefined : 0}
          onKeyDown={
            readonly
              ? undefined
              : (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    startEdit();
                  }
                }
          }
          aria-label={
            readonly
              ? undefined
              : `${FIELD_LABELS[fieldKey]}: ${isEmpty ? 'not set' : value}. Click to edit.`
          }
        >
          {isEmpty ? 'NOT SET — CLICK TO DEFINE' : value}
        </div>
      )}
    </div>
  );
}

// ─── AbsorbConfirm ────────────────────────────────────────────────────────────

interface AbsorbConfirmProps {
  matchedNames: string[];
  onAbsorb: () => void;
  onDismiss: () => void;
  absorbing: boolean;
}

function AbsorbConfirm({ matchedNames, onAbsorb, onDismiss, absorbing }: AbsorbConfirmProps) {
  return (
    <div className="charter-absorb-confirm">
      <ul className="charter-absorb-list">
        {matchedNames.map((name, i) => (
          <li key={i}>{name}</li>
        ))}
      </ul>
      <div className="charter-absorb-hint mono up">
        ORIGINALS WILL BE COMPLETED (REVERSIBLE)
      </div>
      <div className="charter-absorb-actions">
        <button
          className="btn coral"
          style={{ fontSize: 9, padding: '5px 10px' }}
          disabled={absorbing}
          onClick={onAbsorb}
        >
          {absorbing ? 'ABSORBING...' : `ABSORB ${matchedNames.length} → CHARTER`}
        </button>
        <button
          className="btn ghost"
          style={{ fontSize: 9, padding: '5px 10px' }}
          onClick={onDismiss}
        >
          DISMISS
        </button>
      </div>
    </div>
  );
}

// ─── CharterPanel ─────────────────────────────────────────────────────────────

export function CharterPanel({ card }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [showAbsorb, setShowAbsorb] = useState(false);

  const { status: connStatus } = useConnection();
  const readonly = connStatus === 'no-token';

  const { fields, exists, revised, save, saving } = useCharter(card.id);
  const cardTasksQuery = useCardTasks(card.id);
  const absorbMutation = useAbsorbCharter();

  // Detect concept tasks from the card's open todos
  const openTodos = cardTasksQuery.data ?? [];
  const conceptMatches = detectConceptTasks(openTodos);
  const hasConceptTasks = conceptMatches.length > 0;

  // ── Revised label ─────────────────────────────────────────────────────────

  let revisedLabel: string | null = null;
  if (revised) {
    try {
      revisedLabel = format(parseISO(revised), 'MMM d').toUpperCase();
    } catch {
      revisedLabel = revised;
    }
  }

  // ── Save handler: updates one field while keeping others ─────────────────

  function handleFieldSave(fieldKey: keyof CharterFields, newValue: string) {
    const current: CharterFields = fields ?? {
      msc: '', conception: '', planning: '', execution: '',
    };
    save({ ...current, [fieldKey]: newValue });
  }

  // ── Absorb ────────────────────────────────────────────────────────────────

  function handleAbsorb() {
    absorbMutation.mutate(
      { cardId: card.id },
      {
        onSuccess: () => {
          setShowAbsorb(false);
        },
      }
    );
  }

  // ── Strip (always rendered) ───────────────────────────────────────────────

  return (
    <>
      {/* Collapsed strip — always visible */}
      <div
        className="charter-strip"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} card charter`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <div className="charter-strip-toggle mono up">
          <span className={`charter-strip-caret${expanded ? ' open' : ''}`}>▸</span>
          <span className="charter-strip-label">CHARTER · MSC + CPE</span>
        </div>

        {exists && revisedLabel ? (
          <span className="charter-strip-revised mono up">REVISED {revisedLabel}</span>
        ) : (
          <span className="charter-strip-unset mono up">UNSET</span>
        )}

        <div className="charter-strip-spacer" />

        {hasConceptTasks && !readonly && (
          <div
            className="charter-absorb-chip mono up"
            role="button"
            aria-label={`${conceptMatches.length} concept tasks found — absorb into charter`}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(true);
              setShowAbsorb((v) => !v);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                setExpanded(true);
                setShowAbsorb((v) => !v);
              }
            }}
            tabIndex={0}
          >
            {conceptMatches.length} CONCEPT TASKS · ABSORB ▸
          </div>
        )}
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div className="charter-panel">
          {/* ── Left: MSC ─────────────────────────────────────────────── */}
          <div className="charter-col-msc">
            <CharterField
              fieldKey="msc"
              value={fields?.msc ?? ''}
              readonly={readonly || saving}
              onSave={(v) => handleFieldSave('msc', v)}
              large
            />

            {/* Absorb confirm strip */}
            {showAbsorb && hasConceptTasks && (
              <AbsorbConfirm
                matchedNames={conceptMatches.map((m) => m.task.content)}
                onAbsorb={handleAbsorb}
                onDismiss={() => setShowAbsorb(false)}
                absorbing={absorbMutation.isPending}
              />
            )}
          </div>

          {/* ── Right: CPE ────────────────────────────────────────────── */}
          <div className="charter-col-cpe">
            {(['conception', 'planning', 'execution'] as const).map((key) => (
              <CharterField
                key={key}
                fieldKey={key}
                value={fields?.[key] ?? ''}
                readonly={readonly || saving}
                onSave={(v) => handleFieldSave(key, v)}
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
