import { useMemo } from 'react';

/** Weekday table. `key` is the Todoist natural-language token; `label` is the chip glyph. */
const DAYS = [
  { i: 0, key: 'sun', label: 'Su' },
  { i: 1, key: 'mon', label: 'Mo' },
  { i: 2, key: 'tue', label: 'Tu' },
  { i: 3, key: 'wed', label: 'We' },
  { i: 4, key: 'thu', label: 'Th' },
  { i: 5, key: 'fri', label: 'Fr' },
  { i: 6, key: 'sat', label: 'Sa' },
];

/** Day tokens we recognise when parsing a typed string back into chips. */
const DAY_ALIASES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const PRESETS = [
  { label: 'NONE', val: '' },
  { label: 'TODAY', val: 'today' },
  { label: 'TOMORROW', val: 'tomorrow' },
  { label: 'EVERY DAY', val: 'every day' },
];

interface ParsedWeekly {
  days: Set<number>;
  time: string;
}

/** Shared empty set for the no-selection case — avoids a per-render allocation. */
const EMPTY_DAYS: ReadonlySet<number> = new Set<number>();

/**
 * Parse a Todoist "every <days> [at <time>]" string back into a weekday set + time.
 * Returns null when `value` is NOT a pure weekday-recurrence pattern (e.g.
 * "tomorrow 8pm", "every 2 weeks", "every weekday") — in that case the chips render
 * empty and the time box is gated, while the canonical text field keeps the string.
 */
function parseWeekly(value: string): ParsedWeekly | null {
  const v = value.trim().toLowerCase();
  const m = /^every\s+(.+)$/.exec(v);
  if (!m) return null;

  let rest = m[1];
  let time = '';
  // lastIndexOf so the time is the trailing clause (robust to odd free text).
  const at = rest.lastIndexOf(' at ');
  if (at >= 0) {
    time = rest.slice(at + 4).trim();
    rest = rest.slice(0, at).trim();
  }

  if (rest === 'day') return { days: new Set([0, 1, 2, 3, 4, 5, 6]), time };

  const tokens = rest.split(/[\s,]+/).filter(Boolean);
  const days = new Set<number>();
  for (const tok of tokens) {
    const idx = DAY_ALIASES[tok];
    if (idx === undefined) return null; // not a pure weekday list → leave to free text
    days.add(idx);
  }
  return days.size > 0 ? { days, time } : null;
}

interface RecurPickerProps {
  value: string;
  onChange: (due: string) => void;
}

/**
 * Friendly recurrence/due builder for QuickAdd.
 *
 * The free-text field (`value`) is the single source of truth submitted to Todoist.
 * The preset chips, weekday toggles, and time box are all DERIVED from `value` by
 * parsing it, so the controls can never drift out of sync with the text: a typed
 * "every mon, wed" lights Mon+Wed, toggling a chip mutates the parsed set and writes
 * a fresh string, and a non-weekly custom string just leaves the chips empty.
 */
export function RecurPicker({ value, onChange }: RecurPickerProps) {
  const parsed = useMemo(() => parseWeekly(value), [value]);
  const days = parsed?.days ?? EMPTY_DAYS;
  const time = parsed?.time ?? '';

  const buildWeekly = (nextDays: ReadonlySet<number>, nextTime: string): string => {
    if (nextDays.size === 0) return '';
    const ordered = DAYS.filter((d) => nextDays.has(d.i)).map((d) => d.key);
    const base = ordered.length === 7 ? 'every day' : 'every ' + ordered.join(', ');
    // Lowercase so emit matches parseWeekly's lowercased read — keeps the time
    // box and the canonical text field byte-identical (Todoist NL is case-insensitive).
    const t = nextTime.trim().toLowerCase();
    return t ? base + ' at ' + t : base;
  };

  const toggleDay = (i: number) => {
    const next = new Set(days);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    onChange(buildWeekly(next, time));
  };

  const onTimeChange = (t: string) => {
    // Time only composes onto an existing weekday selection.
    if (days.size > 0) onChange(buildWeekly(days, t));
  };

  return (
    <div className="recur">
      <div className="recur-presets">
        {PRESETS.map((p) => (
          <button
            type="button"
            key={p.label}
            className={'recur-chip' + (value.trim() === p.val ? ' on' : '')}
            onClick={() => onChange(p.val)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="recur-week">
        <span className="recur-week-lbl mono up-s">REPEAT ON</span>
        <div className="recur-days">
          {DAYS.map((d) => (
            <button
              type="button"
              key={d.i}
              title={d.key}
              aria-label={d.key}
              aria-pressed={days.has(d.i)}
              className={'recur-day' + (days.has(d.i) ? ' on' : '')}
              onClick={() => toggleDay(d.i)}
            >
              {d.label}
            </button>
          ))}
        </div>
        <input
          className="recur-time mono"
          placeholder="8am"
          value={time}
          disabled={days.size === 0}
          title={days.size === 0 ? 'Pick a repeat day first' : undefined}
          onChange={(e) => onTimeChange(e.target.value)}
          aria-label="Time of day (optional, pick a day first)"
          autoComplete="off"
        />
      </div>

      <input
        className="qa-input mono recur-text"
        placeholder="tomorrow 8pm, every friday..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        aria-label="Due or recurrence (Todoist natural language)"
      />
    </div>
  );
}
