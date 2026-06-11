/**
 * FAIRPLAY · AutoView — Subaru Forester schematic with clickable hotspots.
 * kind: 'auto'  —  data via useCardTasks + useCardConfig
 *
 * Hotspot parts: engine | fluids | tires | brakes | body | electrical
 * Tasks bind to parts via meta.part; tasks without a part appear only in ALL.
 * Odometer persisted to FP-config as { odometer, vehicle }.
 */
import React, { useState, useRef, useEffect } from 'react';
import type { CardDef, FpTask } from '../../lib/types';
import {
  useCardTasks,
  useCardConfig,
  useCloseTask,
  useReopenTask,
  useUpdateTask,
  useConnection,
} from '../../lib/todoist/hooks';
import { LoadState } from '../../shell/atoms';
import { QuickAdd } from '../../shell/QuickAdd';
import { CharterPanel } from '../../shell/CharterPanel';
import { dueLabel } from '../../lib/format';
import './auto.css';

// ─── Part definitions ────────────────────────────────────────────────────────

export type AutoPart = 'engine' | 'fluids' | 'tires' | 'brakes' | 'body' | 'electrical';

interface PartDef {
  id: AutoPart;
  label: string;
}

const PARTS: PartDef[] = [
  { id: 'engine',     label: 'ENGINE'      },
  { id: 'fluids',     label: 'FLUIDS'      },
  { id: 'tires',      label: 'TIRES'       },
  { id: 'brakes',     label: 'BRAKES'      },
  { id: 'body',       label: 'BODY'        },
  { id: 'electrical', label: 'ELECTRICAL'  },
];

// ─── Hotspot positions (on 600 × 360 viewBox, Subaru Forester profile) ───────

interface HotPos {
  /** Centre of the ring dot */
  cx: number;
  cy: number;
  /** Label anchor point */
  lx: number;
  ly: number;
  anchor: 'start' | 'middle' | 'end';
}

const HOT_POS: Record<AutoPart, HotPos> = {
  engine:     { cx: 490, cy: 220, lx: 530, ly: 158, anchor: 'start'  },
  fluids:     { cx: 430, cy: 188, lx: 430, ly: 120, anchor: 'middle' },
  body:       { cx: 300, cy: 155, lx: 300, ly: 110, anchor: 'middle' },
  electrical: { cx: 155, cy: 196, lx: 110, ly: 140, anchor: 'end'    },
  brakes:     { cx: 162, cy: 258, lx: 115, ly: 318, anchor: 'start'  },
  tires:      { cx: 440, cy: 258, lx: 440, ly: 318, anchor: 'middle' },
};

// ─── ForesterSchematic ───────────────────────────────────────────────────────

interface SchematicProps {
  sel: AutoPart | null;
  onSel: (p: AutoPart | null) => void;
}

function ForesterSchematic({ sel, onSel }: SchematicProps) {
  const vw = 600;
  const vh = 370;

  const gridCols = 11;
  const gridRows = 8;
  const cw = vw / gridCols;   // ≈54.5
  const rh = vh / gridRows;   // ≈46.25

  function handleHot(p: AutoPart) {
    onSel(sel === p ? null : p);
  }

  return (
    <svg className="schematic" viewBox={`0 0 ${vw} ${vh}`}>
      {/* Blueprint grid */}
      {Array.from({ length: gridCols + 1 }).map((_, i) => (
        <line key={`v${i}`} className="gridln" x1={i * cw} y1="0" x2={i * cw} y2={vh} />
      ))}
      {Array.from({ length: gridRows + 1 }).map((_, i) => (
        <line key={`h${i}`} className="gridln" x1="0" y1={i * rh} x2={vw} y2={i * rh} />
      ))}

      {/* Ground baseline */}
      <line className="ln2" x1="50" y1="298" x2="560" y2="298" />

      {/*
        ── Subaru Forester body silhouette ──────────────────────────────────
        Boxy compact SUV: tall greenhouse, nearly vertical rear hatch,
        higher ride height, short front/rear overhangs, wide plastic sill trim.
        Front faces right (east).
      */}

      {/* Main body shell */}
      <polygon
        className="fillp"
        points="
          75,258
          88,210
          110,198
          138,196
          158,175
          200,172
          220,158
          390,158
          418,172
          462,196
          490,204
          512,222
          518,248
          515,258
        "
      />

      {/* Rear hatch — near-vertical with slight top rake */}
      <line className="ln2" x1="200" y1="158" x2="198" y2="172" />

      {/* Roof rails — thin lines across the roofline */}
      <line className="ln2" x1="228" y1="154" x2="264" y2="152" />
      <line className="ln2" x1="276" y1="151" x2="320" y2="151" />
      <line className="ln2" x1="332" y1="151" x2="380" y2="153" />

      {/* Greenhouse / glass area (tinted with accent-2 at low opacity) */}
      <polygon
        className="ln2"
        points="224,160 388,160 410,175 204,175"
        fill="color-mix(in srgb, var(--accent-2) 9%, transparent)"
      />

      {/* Windshield post A-pillar */}
      <line className="ln2" x1="224" y1="160" x2="204" y2="175" />

      {/* Rear quarter window division */}
      <line className="ln2" x1="356" y1="160" x2="356" y2="175" />

      {/* Hood line (prominent boxy hood) */}
      <line className="ln2" x1="418" y1="172" x2="462" y2="196" />

      {/* Bumper / front fascia detail */}
      <line className="ln2" x1="512" y1="222" x2="520" y2="238" />
      <line className="ln2" x1="520" y1="238" x2="518" y2="258" />

      {/* Rear bumper */}
      <line className="ln2" x1="75" y1="258" x2="70" y2="270" />
      <line className="ln2" x1="70" y1="270" x2="72" y2="282" />

      {/* Plastic-clad rocker panel hint */}
      <rect
        x="118" y="248" width="284" height="10"
        fill="color-mix(in srgb, var(--ink-3) 10%, transparent)"
        stroke="var(--ink-3)" strokeWidth="0.8"
      />

      {/* Door seam (two doors) */}
      <line className="ln2" x1="300" y1="175" x2="302" y2="258" />

      {/* Front wheel arch */}
      <path
        className="ln2"
        d="M 400,258 A 58,34 0 0 1 516,258"
        fill="none"
      />

      {/* Rear wheel arch */}
      <path
        className="ln2"
        d="M 85,258 A 58,34 0 0 1 240,258"
        fill="none"
      />

      {/* Front wheel — larger, with inner ring and hub detail */}
      <circle className="ln" cx={440} cy={258} r={44} />
      <circle className="ln2" cx={440} cy={258} r={26} />
      <circle className="ln2" cx={440} cy={258} r={8} />
      <circle style={{ fill: 'var(--ink-3)' }} cx={440} cy={258} r={2.5} />

      {/* Rear wheel */}
      <circle className="ln" cx={162} cy={258} r={44} />
      <circle className="ln2" cx={162} cy={258} r={26} />
      <circle className="ln2" cx={162} cy={258} r={8} />
      <circle style={{ fill: 'var(--ink-3)' }} cx={162} cy={258} r={2.5} />

      {/* Wheelbase dimension line */}
      <line className="ln2" x1="162" y1="322" x2="440" y2="322" />
      <line className="ln2" x1="162" y1="316" x2="162" y2="328" />
      <line className="ln2" x1="440" y1="316" x2="440" y2="328" />
      <text
        className="hot-label"
        x="301"
        y="342"
        textAnchor="middle"
        style={{ fill: 'var(--ink-4)' }}
      >
        WHEELBASE 2,670
      </text>

      {/* Ground clearance tick (Forester rides higher) */}
      <line className="ln2" x1="548" y1="258" x2="548" y2="298" />
      <line className="ln2" x1="544" y1="258" x2="552" y2="258" />
      <line className="ln2" x1="544" y1="298" x2="552" y2="298" />
      <text
        className="hot-label"
        x="555"
        y="280"
        textAnchor="start"
        style={{ fill: 'var(--ink-4)', fontSize: 8 }}
      >
        GC
      </text>

      {/* ── Hotspots ──────────────────────────────────────────────────────── */}
      {PARTS.map((p) => {
        const pos = HOT_POS[p.id];
        const active = sel === p.id;
        const ringR = 13;
        // Leader line: from ring edge to label
        const dy = pos.ly > pos.cy ? ringR : -ringR;
        const dy2 = pos.ly > pos.cy ? -10 : 10;

        return (
          <g key={p.id}>
            {/* Leader line */}
            <line
              x1={pos.cx}
              y1={pos.cy + dy}
              x2={pos.lx}
              y2={pos.ly + dy2}
              stroke={active ? 'var(--accent)' : 'var(--line)'}
              strokeWidth="1"
            />
            {/* Clickable ring + core */}
            <g
              className={`hot${active ? ' active' : ''}`}
              onClick={(e) => { e.stopPropagation(); handleHot(p.id); }}
            >
              <circle className="ring" cx={pos.cx} cy={pos.cy} r={ringR} />
              <circle className="core" cx={pos.cx} cy={pos.cy} r={3} />
            </g>
            {/* Label */}
            <text
              className="hot-label"
              x={pos.lx}
              y={pos.ly}
              textAnchor={pos.anchor}
              style={{ fill: active ? 'var(--accent)' : 'var(--ink-2)' }}
            >
              {p.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ─── OdometerDisplay ─────────────────────────────────────────────────────────

interface OdometerProps {
  value: number;
  onSave: (v: number) => void;
}

function OdometerDisplay({ value, onSave }: OdometerProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(String(value));
    setEditing(true);
  }

  useEffect(() => {
    if (editing) {
      setTimeout(() => inputRef.current?.select(), 30);
    }
  }, [editing]);

  function commit() {
    const n = parseInt(draft.replace(/[^\d]/g, ''), 10);
    if (!Number.isNaN(n) && n >= 0) {
      onSave(n);
    }
    setEditing(false);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') setEditing(false);
  }

  const formatted = value.toLocaleString('en-US');

  if (editing) {
    return (
      <div className="odo-edit-wrap">
        <input
          ref={inputRef}
          className="odo-input mono"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={commit}
          autoComplete="off"
          inputMode="numeric"
        />
        <button className="btn ghost odo-save mono up-s" onMouseDown={(e) => e.preventDefault()} onClick={commit}>
          SAVE
        </button>
      </div>
    );
  }

  return (
    <div className="odo-big mono" onClick={startEdit} title="Click to edit odometer">
      {formatted}
      <span className="odo-unit"> mi</span>
    </div>
  );
}

// ─── AutoTaskRow ─────────────────────────────────────────────────────────────

interface AutoTaskRowProps {
  task: FpTask;
  onToggle: () => void;
  onPartChange: (part: string) => void;
}

function AutoTaskRow({ task, onToggle, onPartChange }: AutoTaskRowProps) {
  const dl = dueLabel(task);
  const isDone = task.isCompleted;
  const isRecurring = task.due?.isRecurring ?? false;
  const currentPart = task.meta.part ?? '';

  return (
    <div className={`auto-trow${isDone ? ' done' : ''}`}>
      {/* Checkbox */}
      <button
        type="button"
        role="checkbox"
        aria-checked={isDone}
        aria-label={`Mark "${task.content}" ${isDone ? 'not done' : 'done'}`}
        className={`chk${isRecurring ? ' recur' : ''}${isDone ? ' done' : ''}`}
        onClick={onToggle}
      />

      {/* Body */}
      <div className="auto-trow-body">
        <div className="auto-trow-name">{task.content}</div>
        <div className="auto-trow-sub">
          {task.due && (
            <span className={dl.over ? 'over' : ''}>{dl.main}</span>
          )}
          {isRecurring && <span>⟳</span>}
        </div>
      </div>

      {/* Right: part tag + assign control */}
      <div className="auto-trow-right">
        {currentPart && (
          <span className="mono up-s" style={{ fontSize: 8, color: 'var(--accent-2)' }}>
            {currentPart.toUpperCase()}
          </span>
        )}
        <select
          className="part-select mono up-s"
          value={currentPart}
          onChange={(e) => onPartChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="">— NONE —</option>
          {PARTS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ─── AutoView ────────────────────────────────────────────────────────────────

interface Props {
  card: CardDef;
}

export default function AutoView({ card }: Props) {
  const [sel, setSel] = useState<AutoPart | null>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);

  // Data hooks
  const { status: connStatus } = useConnection();
  const tasksQuery = useCardTasks(card.id);
  const { config, update: updateConfig, isLoading: configLoading } = useCardConfig(card.id);
  const closeTask = useCloseTask();
  const reopenTask = useReopenTask();
  const updateTask = useUpdateTask();

  // ── No-token guard ────────────────────────────────────────────────────────
  if (connStatus === 'no-token') {
    return (
      <div className="view">
        <div className="view-head">
          <div className="auto-view-head-left">
            <div className="auto-glyph mono">{card.num}</div>
            <div>
              <div className="kicker mono up">
                <span className="tick" />
                CARD · {card.category} · CUSTOM VIEW ◆
              </div>
              <div className="view-title">{card.name}</div>
              <div className="view-sub mono up-s" style={{ marginTop: 6, fontSize: 10, color: 'var(--ink-3)' }}>
                SUBARU FORESTER
              </div>
            </div>
          </div>
        </div>
        <CharterPanel card={card} />
        <LoadState status="no-token" />
        <QuickAdd open={quickAddOpen} onClose={() => setQuickAddOpen(false)} presetCardId={card.id} />
      </div>
    );
  }

  // ── Odometer ──────────────────────────────────────────────────────────────
  const odometer = typeof config.odometer === 'number' ? config.odometer : 0;

  function handleSaveOdo(v: number) {
    void updateConfig({ odometer: v, vehicle: 'Subaru Forester' });
  }

  // ── Task helpers ──────────────────────────────────────────────────────────
  const allTasks: FpTask[] = tasksQuery.data ?? [];

  const visibleTasks = sel
    ? allTasks.filter((t) => t.meta.part === sel)
    : allTasks;

  function handleToggle(task: FpTask) {
    if (task.isCompleted) {
      reopenTask.mutate(task.id);
    } else {
      closeTask.mutate(task.id);
    }
  }

  function handlePartChange(task: FpTask, part: string) {
    updateTask.mutate({
      id: task.id,
      patch: {
        meta: { ...task.meta, part: part || undefined },
      },
    });
  }

  // ── Render loading / error states (stage area) ────────────────────────────
  const stageContent = (() => {
    if (tasksQuery.isLoading || configLoading) {
      return <LoadState status="loading" />;
    }
    if (tasksQuery.isError) {
      return (
        <LoadState
          status="error"
          message={String(tasksQuery.error)}
          retry={() => void tasksQuery.refetch()}
        />
      );
    }
    return null;
  })();

  // ── Part label for header ─────────────────────────────────────────────────
  const selPartDef = PARTS.find((p) => p.id === sel);

  return (
    <div className="view">
      {/* ── view-head ─────────────────────────────────────────────────────── */}
      <div className="view-head">
        <div className="auto-view-head-left">
          {/* numbered glyph */}
          <div className="auto-glyph mono">{card.num}</div>
          <div>
            <div className="kicker mono up">
              <span className="tick" />
              CARD · {card.category} · CUSTOM VIEW ◆
            </div>
            <div className="view-title">{card.name}</div>
            <div className="view-sub mono up-s" style={{ marginTop: 6, fontSize: 10, color: 'var(--ink-3)' }}>
              SUBARU FORESTER · {allTasks.length} OPEN
            </div>
          </div>
        </div>

        {/* head-meta: odometer */}
        <div className="head-meta">
          <OdometerDisplay value={odometer} onSave={handleSaveOdo} />
          <div className="mono up" style={{ fontSize: 9.5, color: 'var(--ink-3)', marginTop: 6 }}>
            ODOMETER · MI
          </div>
        </div>
      </div>

      <CharterPanel card={card} />

      {/* ── bespoke layout ─────────────────────────────────────────────────── */}
      <div className="bespoke">
        {/* ── stage (schematic) ──────────────────────────────────────────── */}
        <div className="stage">
          {/* corner ticks */}
          <span className="tick-c tl" />
          <span className="tick-c tr" />
          <span className="tick-c bl" />
          <span className="tick-c br" />

          <div className="stage-head">
            <div className="lbl">SCHEMATIC · SUBARU FORESTER · SIDE</div>
            <div className="lbl">CLICK A SYSTEM TO FILTER ▸</div>
          </div>

          <div className="schematic-wrap">
            {stageContent ?? (
              <ForesterSchematic sel={sel} onSel={setSel} />
            )}
          </div>

          <div className="stage-foot auto-trivia">
            <span>SUBARU FORESTER · 2.5L H4 BOXER</span>
            <span>WHEELBASE 2,670 MM</span>
            <span>REV 01</span>
          </div>
        </div>

        {/* ── side panel ────────────────────────────────────────────────── */}
        <div className="bespoke-side">
          <div className="bs-head">
            <div className="peek-label mono up">
              <span>
                {selPartDef ? `${selPartDef.label} TASKS` : 'ALL TASKS'}
              </span>
              <span>{visibleTasks.length}</span>
            </div>
            {sel && (
              <div className="filter-chip" onClick={() => setSel(null)}>
                FILTER · {selPartDef?.label ?? sel.toUpperCase()}{' '}
                <span className="x">✕</span>
              </div>
            )}
          </div>

          <div className="bs-list">
            {tasksQuery.isLoading ? (
              <LoadState status="loading" />
            ) : tasksQuery.isError ? (
              <LoadState
                status="error"
                message={String(tasksQuery.error)}
                retry={() => void tasksQuery.refetch()}
              />
            ) : visibleTasks.length === 0 ? (
              <LoadState status="empty" message={sel ? `NO ${sel.toUpperCase()} TASKS` : 'NO TASKS'} />
            ) : (
              <div className="tlist">
                {visibleTasks.map((task) => (
                  <AutoTaskRow
                    key={task.id}
                    task={task}
                    onToggle={() => handleToggle(task)}
                    onPartChange={(part) => handlePartChange(task, part)}
                  />
                ))}
              </div>
            )}

            {/* + Task affordance */}
            <button
              className="auto-add-btn mono up"
              onClick={() => setQuickAddOpen(true)}
            >
              + TASK
            </button>
          </div>
        </div>
      </div>

      {/* QuickAdd modal preset to this card */}
      <QuickAdd
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        presetCardId={card.id}
      />
    </div>
  );
}
