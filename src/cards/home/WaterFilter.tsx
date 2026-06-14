/**
 * FAIRPLAY · Home Maintenance · Water Filter Panel
 *
 * A wireframe SVG schematic of the under-sink filter cartridge with live
 * health state, controls, and optional purchase CTA. Uses the cyberpunk
 * blueprint visual language shared by the home card.
 *
 * Props:
 *   card    — the home card definition (used for card.id and useCreateTask)
 *   onClose — callback to return to the main task view
 */
import React, { useState } from 'react';
import type { CardDef } from '../../lib/types';
import { useWaterFilter, useCreateTask, useConnection } from '../../lib/todoist/hooks';
import { filterDateLabel } from '../../lib/filter-health';
import { LoadState } from '../../shell/atoms';
import './water-filter.css';

interface Props {
  card: CardDef;
  onClose: () => void;
}

// ─── Filter canister SVG ─────────────────────────────────────────────────────

interface CanisterProps {
  lifeFrac: number;
  status: 'ok' | 'low' | 'out';
  pct: number;
  chip: string;
}

function FilterCanister({ lifeFrac, status, pct, chip }: CanisterProps) {
  // Canister geometry (all in SVG user units)
  const CX = 100;          // horizontal center
  const CAP_Y = 28;        // top of screw cap
  const CAP_H = 22;        // height of cap
  const BODY_Y = 50;       // top of housing body
  const BODY_H = 160;      // height of housing body
  const BODY_W = 56;       // width of housing body
  const BODY_X = CX - BODY_W / 2;
  const INNER_X = BODY_X + 6;
  const INNER_W = BODY_W - 12;
  const INNER_Y = BODY_Y + 6;
  const INNER_H = BODY_H - 12;

  // Fill level rises from the bottom: full INNER_H at lifeFrac=1, 0 at lifeFrac=0
  const fillH = Math.max(0, Math.min(INNER_H, Math.round(INNER_H * lifeFrac)));
  const fillY = INNER_Y + (INNER_H - fillH);

  const fillColor =
    status === 'ok'  ? 'var(--accent-2)'  :
    status === 'low' ? '#E0A23A'            :
                        'var(--accent)';

  // Tick marks up the right side of the housing (every 25%)
  const ticks = [0.25, 0.5, 0.75, 1.0];

  return (
    <svg className="wf-canister" viewBox="0 0 200 280" aria-label="Filter cartridge health">
      {/* ── Background grid ─────────────────────────────────────── */}
      {Array.from({ length: 7 }, (_, i) => i * 40).map((x) => (
        <line key={`gc${x}`} className="wf-grid" x1={x} y1={0} x2={x} y2={280} />
      ))}
      {Array.from({ length: 8 }, (_, i) => i * 40).map((y) => (
        <line key={`gr${y}`} className="wf-grid" x1={0} y1={y} x2={200} y2={y} />
      ))}

      {/* ── Inlet pipe stub (top-left shoulder of housing) ────── */}
      <line className="wf-pipe" x1={BODY_X - 18} y1={BODY_Y + 18} x2={BODY_X} y2={BODY_Y + 18} />
      <rect className="wf-pipe-cap" x={BODY_X - 22} y={BODY_Y + 14} width={6} height={8} />
      <text className="wf-pipe-lbl" x={BODY_X - 24} y={BODY_Y + 30}>IN</text>

      {/* ── Outlet pipe stub (top-right shoulder of housing) ──── */}
      <line className="wf-pipe" x1={BODY_X + BODY_W} y1={BODY_Y + 18} x2={BODY_X + BODY_W + 18} y2={BODY_Y + 18} />
      <rect className="wf-pipe-cap" x={BODY_X + BODY_W + 16} y={BODY_Y + 14} width={6} height={8} />
      <text className="wf-pipe-lbl" x={BODY_X + BODY_W + 20} y={BODY_Y + 30}>OUT</text>

      {/* ── Housing outer body ────────────────────────────────── */}
      <rect
        className="wf-housing"
        x={BODY_X} y={BODY_Y}
        width={BODY_W} height={BODY_H}
        rx={4}
      />

      {/* ── Cartridge fill (from bottom) ─────────────────────── */}
      {fillH > 0 && (
        <rect
          className="wf-fill"
          x={INNER_X}
          y={fillY}
          width={INNER_W}
          height={fillH}
          style={{ fill: fillColor }}
        />
      )}

      {/* ── Cartridge inner border (outline of inner chamber) ─── */}
      <rect
        className="wf-inner"
        x={INNER_X} y={INNER_Y}
        width={INNER_W} height={INNER_H}
        rx={2}
      />

      {/* ── Tick marks on right side ──────────────────────────── */}
      {ticks.map((frac) => {
        const ty = INNER_Y + INNER_H - Math.round(INNER_H * frac);
        const isActive = lifeFrac >= frac - 0.01;
        return (
          <g key={frac}>
            <line
              className={`wf-tick${isActive ? ' active' : ''}`}
              x1={BODY_X + BODY_W + 2}
              y1={ty}
              x2={BODY_X + BODY_W + 9}
              y2={ty}
            />
            <text className="wf-tick-lbl" x={BODY_X + BODY_W + 11} y={ty + 1}>
              {Math.round(frac * 100)}%
            </text>
          </g>
        );
      })}

      {/* ── Screw cap on top ──────────────────────────────────── */}
      {/* Cap body */}
      <rect
        className="wf-cap"
        x={BODY_X + 6} y={CAP_Y}
        width={BODY_W - 12} height={CAP_H}
        rx={3}
      />
      {/* Cap thread lines */}
      {[6, 11, 16].map((dy) => (
        <line
          key={dy}
          className="wf-cap-thread"
          x1={BODY_X + 8} y1={CAP_Y + dy}
          x2={BODY_X + BODY_W - 8} y2={CAP_Y + dy}
        />
      ))}
      {/* Cap connector nub at top */}
      <rect
        className="wf-cap"
        x={BODY_X + 18} y={CAP_Y - 10}
        width={BODY_W - 36} height={12}
        rx={2}
      />

      {/* ── Big percent readout ───────────────────────────────── */}
      <text className="wf-pct" x={CX} y={BODY_Y + BODY_H / 2 - 6}>
        {pct}%
      </text>

      {/* ── Status chip label ────────────────────────────────── */}
      <rect
        className={`wf-chip-bg wf-chip-${status}`}
        x={CX - 24} y={BODY_Y + BODY_H / 2 + 4}
        width={48} height={14}
        rx={2}
      />
      <text className={`wf-chip-txt wf-chip-${status}`} x={CX} y={BODY_Y + BODY_H / 2 + 14}>
        {chip}
      </text>

      {/* ── Bottom mount base ────────────────────────────────── */}
      <rect
        className="wf-mount"
        x={BODY_X - 8} y={BODY_Y + BODY_H}
        width={BODY_W + 16} height={8}
        rx={1}
      />
      <line
        className="wf-pipe"
        x1={CX - 8} y1={BODY_Y + BODY_H + 8}
        x2={CX - 8} y2={BODY_Y + BODY_H + 22}
      />
      <line
        className="wf-pipe"
        x1={CX + 8} y1={BODY_Y + BODY_H + 8}
        x2={CX + 8} y2={BODY_Y + BODY_H + 22}
      />

      {/* ── Title block ───────────────────────────────────────── */}
      <rect className="wf-title-block" x={4} y={244} width={90} height={22} />
      <line className="wf-dim" x1={4} y1={251} x2={94} y2={251} />
      <line className="wf-dim" x1={49} y1={244} x2={49} y2={266} />
      <text className="wf-title-txt" x={27} y={248}>FILTER</text>
      <text className="wf-title-txt" x={72} y={248}>CARTRIDGE</text>
      <text className="wf-title-txt" x={27} y={261}>DETAIL</text>
      <text className="wf-title-txt" x={72} y={261}>NTS</text>
    </svg>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function WaterFilter({ card, onClose }: Props) {
  const { status: connStatus } = useConnection();
  const {
    state,
    status,
    daysLeft,
    lifeFrac,
    pct,
    replaceByLabel,
    chip,
    isLoading,
    markReplaced,
    setLifespan,
    setInstalled,
    setWarnDays,
  } = useWaterFilter(card.id);

  const createTask = useCreateTask();

  // Purchase CTA state
  const [purchaseAdded, setPurchaseAdded] = useState(false);

  function handleAddPurchaseTask(): void {
    createTask.mutate(
      {
        content: 'Buy replacement water filter',
        cardId: card.id,
        due: 'today',
      },
      {
        onSuccess: () => setPurchaseAdded(true),
      }
    );
  }

  // ── Guard: no token ───────────────────────────────────────────────────────
  if (connStatus === 'no-token') {
    return (
      <div className="wf-panel">
        <button className="wf-back btn ghost" onClick={onClose}>
          ◂ BACK TO TASKS
        </button>
        <LoadState status="no-token" />
      </div>
    );
  }

  // ── Guard: loading ────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="wf-panel">
        <button className="wf-back btn ghost" onClick={onClose}>
          ◂ BACK TO TASKS
        </button>
        <LoadState status="loading" />
      </div>
    );
  }

  const isWarning = status === 'low' || status === 'out';

  return (
    <div className="wf-panel">
      {/* ── Back control ─────────────────────────────────────────────────── */}
      <div className="wf-nav">
        <button className="wf-back btn ghost" onClick={onClose}>
          ◂ BACK TO TASKS
        </button>
        <span className="wf-nav-title mono up">WATER FILTER · HEALTH MONITOR</span>
      </div>

      {/* ── Main body: canister + readout + controls ─────────────────────── */}
      <div className="wf-body">

        {/* Left: canister SVG */}
        <div className="wf-stage">
          <div className="tick-c tl" /><div className="tick-c tr" />
          <div className="tick-c bl" /><div className="tick-c br" />

          <div className="wf-stage-head mono up">
            <span>FILTER SCHEMATIC · UNDER-SINK UNIT</span>
            <span className={`wf-status-badge wf-status-${status}`}>{status.toUpperCase()}</span>
          </div>

          <div className="wf-canister-wrap">
            <FilterCanister
              lifeFrac={lifeFrac}
              status={status}
              pct={pct}
              chip={chip}
            />
          </div>

          <div className="wf-stage-foot mono">
            <span>SHEET A-2 · SCALE NTS</span>
            <span>FILTER HEALTH</span>
            <span>REV 01</span>
          </div>
        </div>

        {/* Right: readout + warning + controls */}
        <div className="wf-side">

          {/* Readout block */}
          <section className="wf-section">
            <div className="wf-section-head mono up">CARTRIDGE STATUS</div>

            <div className="wf-readout-row">
              <span className="wf-readout-lbl">INSTALLED</span>
              <span className="wf-readout-val mono">{filterDateLabel(state.installed)}</span>
            </div>
            <div className="wf-readout-row">
              <span className="wf-readout-lbl">REPLACE BY</span>
              <span className="wf-readout-val mono">{replaceByLabel}</span>
            </div>
            <div className="wf-readout-row">
              <span className="wf-readout-lbl">DAYS LEFT</span>
              <span className={`wf-readout-val mono${daysLeft <= 0 ? ' wf-overdue' : ''}`}>
                {daysLeft <= 0 ? 'OVERDUE' : String(daysLeft)}
              </span>
            </div>
            <div className="wf-readout-row">
              <span className="wf-readout-lbl">LIFESPAN</span>
              <span className="wf-readout-val mono">{state.lifespanDays} DAYS</span>
            </div>
          </section>

          {/* Purchase warning (when low or out) */}
          {isWarning && (
            <section className={`wf-section wf-warning wf-warning-${status}`}>
              <div className="wf-warning-head mono up">
                {status === 'out' ? '◆ REPLACE NOW' : '◆ REPLACEMENT NEEDED SOON'}
              </div>
              <p className="wf-warning-body">
                {status === 'out'
                  ? 'Filter cartridge is past its service life. Replace immediately.'
                  : `Only ${daysLeft} day${daysLeft !== 1 ? 's' : ''} of filter life remaining.`}
              </p>
              <button
                className={`btn${status === 'out' ? ' coral' : ''} wf-purchase-btn`}
                onClick={handleAddPurchaseTask}
                disabled={purchaseAdded || createTask.isPending}
              >
                {purchaseAdded
                  ? '✓ ADDED TO TASKS'
                  : createTask.isPending
                  ? 'ADDING…'
                  : '+ ADD: Buy replacement filter'}
              </button>
            </section>
          )}

          {/* Controls */}
          <section className="wf-section">
            <div className="wf-section-head mono up">CONTROLS</div>

            {/* Mark replaced */}
            <div className="wf-ctrl-row">
              <span className="wf-ctrl-lbl mono">MARK REPLACED TODAY</span>
              <button
                className="btn ghost wf-ctrl-btn"
                onClick={markReplaced}
                title="Reset install date to today"
              >
                REPLACED
              </button>
            </div>

            {/* Lifespan input */}
            <div className="wf-ctrl-row">
              <label className="wf-ctrl-lbl mono" htmlFor="wf-lifespan">
                LIFESPAN (DAYS)
              </label>
              <input
                id="wf-lifespan"
                className="wf-num-input mono"
                type="number"
                min={1}
                max={730}
                step={1}
                defaultValue={state.lifespanDays}
                key={state.lifespanDays}
                onBlur={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (v >= 1 && v !== state.lifespanDays) setLifespan(v);
                }}
              />
            </div>

            {/* Install date input */}
            <div className="wf-ctrl-row">
              <label className="wf-ctrl-lbl mono" htmlFor="wf-installed">
                INSTALL DATE
              </label>
              <input
                id="wf-installed"
                className="wf-date-input mono"
                type="date"
                defaultValue={state.installed}
                key={state.installed}
                onBlur={(e) => {
                  const v = e.target.value;
                  if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v !== state.installed) {
                    setInstalled(v);
                  }
                }}
              />
            </div>

            {/* Warn days input */}
            <div className="wf-ctrl-row">
              <label className="wf-ctrl-lbl mono" htmlFor="wf-warn-days">
                WARN AT (DAYS LEFT)
              </label>
              <input
                id="wf-warn-days"
                className="wf-num-input mono"
                type="number"
                min={0}
                max={state.lifespanDays}
                step={1}
                defaultValue={state.warnDays}
                key={state.warnDays}
                onBlur={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v >= 0 && v !== state.warnDays) setWarnDays(v);
                }}
              />
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}
