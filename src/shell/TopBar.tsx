/**
 * FAIRPLAY · TopBar shell component.
 * Matches prototype: brand mark + FAIRPLAY, MY DECK meta, live overdue count,
 * ticking clock 'WED 11 JUN · 09:14', settings glyph, decorative Cross.
 */
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDeckTasks } from '../lib/todoist/hooks';
import { dueLabel } from '../lib/format';
import { useProfile, useSettings } from '../state/settings';
import { PROFILES, PROFILE_ORDER } from '../cards/deck-config';

// ─── Cross SVG (decorative, from prototype) ──────────────────────────────────

function Cross({ s = 11, c = 'var(--ink-3)' }: { s?: number; c?: string }) {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 10 10"
      style={{ display: 'block', flex: `0 0 ${s}px` }}
    >
      <line x1="5" y1="0" x2="5" y2="10" stroke={c} strokeWidth="1" />
      <line x1="0" y1="5" x2="10" y2="5" stroke={c} strokeWidth="1" />
      <circle cx="5" cy="5" r="2.2" fill="none" stroke={c} strokeWidth="1" />
    </svg>
  );
}

// ─── Settings glyph ───────────────────────────────────────────────────────────

function SettingsGlyph({ s = 15, c = 'var(--ink-3)' }: { s?: number; c?: string }) {
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 16 16"
      fill="none"
      stroke={c}
      strokeWidth="1.2"
      strokeLinecap="square"
      style={{ display: 'block' }}
    >
      <circle cx="8" cy="8" r="2.5" />
      {/* 8 tick marks */}
      <line x1="8" y1="1" x2="8" y2="3" />
      <line x1="8" y1="13" x2="8" y2="15" />
      <line x1="1" y1="8" x2="3" y2="8" />
      <line x1="13" y1="8" x2="15" y2="8" />
      <line x1="2.93" y1="2.93" x2="4.34" y2="4.34" />
      <line x1="11.66" y1="11.66" x2="13.07" y2="13.07" />
      <line x1="13.07" y1="2.93" x2="11.66" y2="4.34" />
      <line x1="4.34" y1="11.66" x2="2.93" y2="13.07" />
    </svg>
  );
}

// ─── Live clock ───────────────────────────────────────────────────────────────

const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function formatClock(d: Date): string {
  const dow = DAY_NAMES[d.getDay()];
  const day = String(d.getDate()).padStart(2, '0');
  const mon = MONTH_NAMES[d.getMonth()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${dow} ${day} ${mon} · ${hh}:${mm}`;
}

function LiveClock() {
  const [tick, setTick] = useState(() => formatClock(new Date()));

  useEffect(() => {
    // Align to next minute boundary, then tick every 60 s.
    // Both the initial timeout and the resulting interval must be
    // cleared in the effect cleanup (hoisted out of the setTimeout cb).
    let intervalId: ReturnType<typeof setInterval> | undefined;
    const now = new Date();
    const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    const timeout = setTimeout(() => {
      setTick(formatClock(new Date()));
      intervalId = setInterval(() => setTick(formatClock(new Date())), 60_000);
    }, msToNextMinute);
    return () => {
      clearTimeout(timeout);
      if (intervalId !== undefined) clearInterval(intervalId);
    };
  }, []);

  return <span className="tb-clock mono">{tick}</span>;
}

// ─── TopBar ──────────────────────────────────────────────────────────────────

export function TopBar() {
  const navigate = useNavigate();
  const { data: tasks = [] } = useDeckTasks();
  const profile = useProfile();
  const setProfile = useSettings((s) => s.setProfile);

  // Count overdue tasks
  const now = new Date();
  const overdueCount = tasks.filter((t) => {
    if (t.isCompleted) return false;
    const dl = dueLabel(t, now);
    return dl.over;
  }).length;

  return (
    <div className="topbar">
      {/* Brand — navigates home to the triage inbox */}
      <button
        className="brand"
        onClick={() => navigate('/')}
        title="Triage inbox"
        style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit' }}
      >
        <div className="brand-mark" />
        <span className="brand-name">FAIRPLAY</span>
      </button>

      <div className="tb-sep" />

      {/* Profile toggle */}
      <div className="seg mini">
        {PROFILE_ORDER.map((id) => (
          <button
            key={id}
            className={profile === id ? 'on' : ''}
            onClick={() => setProfile(id)}
          >
            {PROFILES[id].name.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="tb-spacer" />

      {/* Overdue count — only show when there are overdue tasks */}
      {overdueCount > 0 && (
        <>
          <div className="tb-stat mono">
            <span className="dot" />
            <b>{overdueCount}</b>&nbsp;OVERDUE
          </div>
          <div className="tb-sep" />
        </>
      )}

      {/* Clock */}
      <LiveClock />

      <div className="tb-sep" />

      {/* Settings glyph */}
      <button
        onClick={() => navigate('/settings')}
        style={{
          background: 'transparent',
          border: 0,
          cursor: 'pointer',
          padding: '4px',
          display: 'flex',
          alignItems: 'center',
        }}
        title="Settings"
      >
        <SettingsGlyph />
      </button>

      {/* Decorative cross */}
      <Cross s={12} />
    </div>
  );
}
