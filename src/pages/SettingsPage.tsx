/**
 * FAIRPLAY · SettingsPage
 * Skin, Accent, Density, Grid, Inventory display, Todoist Link section.
 */
import React, { useState } from 'react';
import { useSettings } from '../state/settings';
import { useDeck, useDeckTasks, useConnection, useAbsorbCharter, useDeckCharters } from '../lib/todoist/hooks';
import { detectConceptTasks } from '../lib/charter';
import type { Theme, Density, InvDisplay } from '../state/settings';
import type { CardDef } from '../lib/types';

// ─── Accent swatches ─────────────────────────────────────────────────────────

const ACCENT_SWATCHES = [
  '#EE3D17',
  '#0C857C',
  '#FF3D8B',
  '#E0A23A',
  '#7A5AE0',
];

// ─── Connection status chip ───────────────────────────────────────────────────

function ConnectionChip() {
  const { status, error } = useConnection();

  let label: string;
  let cls: string;

  switch (status) {
    case 'ok':
      label = 'OK · LINKED';
      cls = 'chip ok';
      break;
    case 'checking':
      label = 'CHECKING...';
      cls = 'chip';
      break;
    case 'error':
      label = 'ERROR';
      cls = 'chip low';
      break;
    default:
      label = 'NO TOKEN';
      cls = 'chip';
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className={`${cls} mono up`}>{label}</span>
      {status === 'error' && error && (
        <div className="mono" style={{ fontSize: 9, color: 'var(--accent)', marginTop: 4 }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ─── Deck readout ─────────────────────────────────────────────────────────────

function DeckReadout() {
  const { data: deck, isLoading, isError } = useDeck();

  if (isLoading) {
    return <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>LOADING DECK...</span>;
  }
  if (isError || !deck) {
    return <span className="mono" style={{ fontSize: 10, color: 'var(--accent)' }}>DECK NOT FOUND — CHECK PROJECT NAME</span>;
  }

  return (
    <span className="mono" style={{ fontSize: 10, color: 'var(--ink-2)' }}>
      MY FAIR PLAY CARDS · {deck.length} CARDS
    </span>
  );
}

// ─── Token input with masked toggle ──────────────────────────────────────────

function TokenInput() {
  const { token, set } = useSettings();
  const [draft, setDraft] = useState(token ?? '');
  const [show, setShow] = useState(false);

  function save() {
    set({ token: draft.trim() || null });
  }

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <input
        type={show ? 'text' : 'password'}
        className="qa-input mono"
        style={{ flex: 1, fontFamily: '"JetBrains Mono", monospace', fontSize: 12, letterSpacing: '0.04em' }}
        placeholder="PASTE TOKEN HERE..."
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === 'Enter') { save(); } }}
        autoComplete="off"
      />
      <button
        className="btn ghost"
        style={{ padding: '8px 10px', fontSize: 9 }}
        onClick={() => setShow((s) => !s)}
        type="button"
      >
        {show ? 'HIDE' : 'SHOW'}
      </button>
      <button
        className="btn coral"
        style={{ padding: '8px 12px', fontSize: 9 }}
        onClick={save}
        type="button"
      >
        SAVE
      </button>
    </div>
  );
}

// ─── ChartersSection ──────────────────────────────────────────────────────────

/**
 * Bulk absorb section: shows how many cards have unabsorbed concept tasks,
 * lets the user absorb all at once with sequential progress display.
 * Note: useDeckTasks excludes carriers (FP-charter) by design, so concept
 * tasks that were already absorbed (closed) will not be counted.
 */
function ChartersSection() {
  const { data: deck } = useDeck();
  const { data: tasks } = useDeckTasks();
  const deckCharters = useDeckCharters();
  const absorbMutation = useAbsorbCharter();
  const { status: connStatus } = useConnection();

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [done, setDone] = useState<{ total: number; cards: number } | null>(null);

  if (connStatus === 'no-token' || !deck || !tasks) return null;

  // Find cards where absorb will actually do something:
  // at least one detected concept task maps to a currently-empty charter field.
  // This mirrors the !nextFields[field] guard in useAbsorbCharter.
  const cardsWithConcepts: CardDef[] = [];
  for (const card of deck) {
    const cardTasks = tasks.filter((t) => t.cardId === card.id);
    const matches = detectConceptTasks(cardTasks);
    if (matches.length === 0) continue;
    const charterFields = deckCharters.get(card.id) ?? null;
    const hasEmptyTargetField = matches.some(
      ({ field }) => !charterFields || !charterFields[field]
    );
    if (hasEmptyTargetField) cardsWithConcepts.push(card);
  }

  const unabsorbedCount = cardsWithConcepts.length;

  async function handleAbsorbAll() {
    if (cardsWithConcepts.length === 0 || running) return;
    setRunning(true);
    setProgress([]);
    setDone(null);

    let totalAbsorbed = 0;
    let cardsAbsorbed = 0;

    for (const card of cardsWithConcepts) {
      setProgress((p) => [...p, `Absorbing ${card.name}...`]);
      try {
        const result = await absorbMutation.mutateAsync({ cardId: card.id });
        if (result.absorbed > 0) {
          totalAbsorbed += result.absorbed;
          cardsAbsorbed += 1;
          setProgress((p) => [
            ...p.slice(0, -1),
            `${card.name} · ${result.absorbed} task${result.absorbed === 1 ? '' : 's'} absorbed`,
          ]);
        } else {
          setProgress((p) => [...p.slice(0, -1), `${card.name} · nothing new to absorb`]);
        }
      } catch {
        setProgress((p) => [...p.slice(0, -1), `${card.name} · error`]);
      }
    }

    setRunning(false);
    setDone({ total: totalAbsorbed, cards: cardsAbsorbed });
  }

  return (
    <>
      <div
        className="mono up"
        style={{ fontSize: 9.5, color: 'var(--ink-4)', marginTop: 28, marginBottom: 14, letterSpacing: '0.12em' }}
      >
        CHARTERS
      </div>

      <div className="cfg-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <span className="lbl">CONCEPT TASKS</span>
          <span className="mono" style={{ fontSize: 10, color: unabsorbedCount > 0 ? 'var(--accent)' : 'var(--ink-3)' }}>
            {unabsorbedCount} CARD{unabsorbedCount !== 1 ? 'S' : ''} WITH UNABSORBED CONCEPT TASKS
          </span>
        </div>

        <div className="mono" style={{ fontSize: 9, color: 'var(--ink-4)', lineHeight: 1.5 }}>
          CONCEPT TASKS ARE COMPLETED (NOT DELETED) — FULLY REVERSIBLE.
        </div>

        {done && (
          <div className="mono" style={{ fontSize: 10, color: 'var(--accent-2)', letterSpacing: '.08em' }}>
            ✓ {done.total} TASK{done.total !== 1 ? 'S' : ''} ABSORBED ACROSS {done.cards} CARD{done.cards !== 1 ? 'S' : ''}
          </div>
        )}

        {progress.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {progress.map((msg, i) => (
              <div key={i} className="mono" style={{ fontSize: 9, color: 'var(--ink-2)', letterSpacing: '.06em' }}>
                {msg}
              </div>
            ))}
          </div>
        )}

        <button
          className="btn coral"
          style={{ fontSize: 9, padding: '6px 12px' }}
          disabled={running || unabsorbedCount === 0}
          onClick={() => void handleAbsorbAll()}
        >
          {running ? 'ABSORBING...' : 'ABSORB ALL → CHARTERS'}
        </button>
      </div>
    </>
  );
}

// ─── SettingsPage ─────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { theme, density, showGrid, accent, invDisplay, set } = useSettings();
  const { status: connStatus } = useConnection();

  return (
    <div className="view">
      {/* Header */}
      <div className="view-head">
        <div>
          <div className="kicker mono up">
            <span className="tick" />
            SETTINGS
          </div>
          <div className="view-title">Preferences</div>
          <div className="view-sub">Theme, display, and account settings</div>
        </div>
      </div>

      <div className="view-body">
        <div style={{ padding: '26px', maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 0 }}>

          {/* ── APPEARANCE ───────────────────────────────────────────────── */}
          <div className="mono up" style={{ fontSize: 9.5, color: 'var(--ink-4)', marginBottom: 14, letterSpacing: '0.12em' }}>
            APPEARANCE
          </div>

          {/* Skin */}
          <div className="cfg-row">
            <span className="lbl">SKIN</span>
            <div className="seg">
              {(['bone', 'eclipse', 'vapor'] as Theme[]).map((t) => (
                <button
                  key={t}
                  className={theme === t ? 'on' : ''}
                  onClick={() => set({ theme: t })}
                >
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Accent */}
          <div className="cfg-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 10 }}>
            <span className="lbl">ACCENT COLOR</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {ACCENT_SWATCHES.map((hex) => (
                <button
                  key={hex}
                  onClick={() => set({ accent: hex })}
                  title={hex}
                  style={{
                    width: 28,
                    height: 28,
                    background: hex,
                    border: accent === hex ? '2px solid var(--ink)' : '1px solid var(--line)',
                    cursor: 'pointer',
                    padding: 0,
                    outline: accent === hex ? '1px solid var(--ink)' : 'none',
                    outlineOffset: 2,
                  }}
                />
              ))}
              <button
                className="btn ghost"
                style={{ fontSize: 9, padding: '5px 10px' }}
                onClick={() => set({ accent: null })}
              >
                RESET TO SKIN DEFAULT
              </button>
            </div>
            {accent && (
              <div className="mono" style={{ fontSize: 9, color: 'var(--ink-3)' }}>
                OVERRIDE: {accent.toUpperCase()}
              </div>
            )}
          </div>

          {/* Density */}
          <div className="cfg-row">
            <span className="lbl">DENSITY</span>
            <div className="seg">
              {(['compact', 'regular', 'comfy'] as Density[]).map((d) => (
                <button
                  key={d}
                  className={density === d ? 'on' : ''}
                  onClick={() => set({ density: d })}
                >
                  {d.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Background grid */}
          <div className="cfg-row">
            <span className="lbl">BACKGROUND GRID</span>
            <div className="seg">
              <button className={showGrid ? 'on' : ''} onClick={() => set({ showGrid: true })}>ON</button>
              <button className={!showGrid ? 'on' : ''} onClick={() => set({ showGrid: false })}>OFF</button>
            </div>
          </div>

          {/* Inventory count display */}
          <div className="cfg-row">
            <span className="lbl">INVENTORY COUNT DISPLAY</span>
            <div className="seg">
              {(['stacked', 'inline', 'toggle'] as InvDisplay[]).map((v) => (
                <button
                  key={v}
                  className={invDisplay === v ? 'on' : ''}
                  onClick={() => set({ invDisplay: v })}
                >
                  {v.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* ── TODOIST LINK ──────────────────────────────────────────────── */}
          <div
            className="mono up"
            style={{ fontSize: 9.5, color: 'var(--ink-4)', marginTop: 28, marginBottom: 14, letterSpacing: '0.12em' }}
          >
            TODOIST LINK
          </div>

          {/* Token */}
          <div className="cfg-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 10 }}>
            <span className="lbl">API TOKEN</span>
            <TokenInput />
            <div className="mono" style={{ fontSize: 9, color: 'var(--ink-4)', lineHeight: 1.5 }}>
              TOKEN STORED LOCALLY. NEVER SENT TO ANY SERVER EXCEPT TODOIST.
              {import.meta.env.VITE_TODOIST_API_TOKEN && (
                <> · ENV VAR FALLBACK ACTIVE (VITE_TODOIST_API_TOKEN)</>
              )}
            </div>
            <a
              href="https://todoist.com/app/settings/integrations/developer"
              target="_blank"
              rel="noopener noreferrer"
              className="mono"
              style={{ fontSize: 9, color: 'var(--accent-2)', textDecoration: 'none' }}
            >
              GET TOKEN AT TODOIST INTEGRATIONS ↗
            </a>
          </div>

          {/* Connection status */}
          <div className="cfg-row">
            <span className="lbl">CONNECTION STATUS</span>
            <ConnectionChip />
          </div>

          {/* Deck readout — only when linked */}
          {(connStatus === 'ok' || connStatus === 'checking') && (
            <div className="cfg-row">
              <span className="lbl">DECK</span>
              <DeckReadout />
            </div>
          )}

          {/* ── CHARTERS ──────────────────────────────────────────────── */}
          {(connStatus === 'ok' || connStatus === 'checking') && (
            <ChartersSection />
          )}

        </div>
      </div>
    </div>
  );
}
