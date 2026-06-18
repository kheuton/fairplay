/**
 * Tests for the RFC-5545 iCalendar builder (src/ics.ts).
 *
 * Covers:
 *   • escapeText: commas, semicolons, backslashes, newlines
 *   • foldLine: lines <=75 chars pass through; longer lines fold with CRLF+SP
 *   • contentLine: name:value + folding + CRLF
 *   • formatAllDayDtstart: VALUE=DATE output
 *   • formatTimedDtstart: UTC "Z" normalisation
 *   • formatDtstamp: UTC format
 *   • buildVEvent: all-day, timed, with RRULE, with description
 *   • buildVCalendar: envelope, PRODID, VERSION, CALSCALE, X-WR-CALNAME
 *   • CRLF line endings throughout
 */

import { describe, it, expect } from 'vitest';
import {
  escapeText,
  foldLine,
  contentLine,
  formatAllDayDtstart,
  formatTimedDtstart,
  formatDtstamp,
  buildVEvent,
  buildVCalendar,
} from './ics.js';

// ---------------------------------------------------------------------------
// escapeText
// ---------------------------------------------------------------------------

describe('escapeText', () => {
  it('escapes backslash', () => {
    expect(escapeText('a\\b')).toBe('a\\\\b');
  });

  it('escapes semicolon', () => {
    expect(escapeText('a;b')).toBe('a\\;b');
  });

  it('escapes comma', () => {
    expect(escapeText('a,b')).toBe('a\\,b');
  });

  it('escapes Unix newline', () => {
    expect(escapeText('a\nb')).toBe('a\\nb');
  });

  it('escapes Windows CRLF newline', () => {
    expect(escapeText('a\r\nb')).toBe('a\\nb');
  });

  it('escapes carriage return', () => {
    expect(escapeText('a\rb')).toBe('a\\nb');
  });

  it('escapes multiple special chars', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeText('Hello World')).toBe('Hello World');
  });
});

// ---------------------------------------------------------------------------
// foldLine
// ---------------------------------------------------------------------------

describe('foldLine', () => {
  it('returns short lines unchanged', () => {
    const line = 'SUMMARY:Hello';
    expect(foldLine(line)).toBe(line);
  });

  it('returns exactly 75-char line unchanged', () => {
    const line = 'X'.repeat(75);
    expect(foldLine(line)).toBe(line);
  });

  it('folds a 76-char line at 75 chars with CRLF+SP', () => {
    const line = 'X'.repeat(76);
    const folded = foldLine(line);
    expect(folded).toBe('X'.repeat(75) + '\r\n ' + 'X');
  });

  it('folds a long line into multiple chunks', () => {
    // 75 + 74 + 74 = 223 chars total
    const line = 'A'.repeat(75) + 'B'.repeat(74) + 'C'.repeat(74);
    const folded = foldLine(line);
    const foldedLines = folded.split('\r\n');
    expect(foldedLines[0].length).toBe(75);
    expect(foldedLines[1]).toBe(' ' + 'B'.repeat(74));
    expect(foldedLines[2]).toBe(' ' + 'C'.repeat(74));
  });

  // -------------------------------------------------------------------------
  // Multi-byte Unicode folding (FIX 1: fold by UTF-8 octets, not UTF-16 units)
  // -------------------------------------------------------------------------

  it('folds multi-byte 2-octet chars (é = 2 bytes) at octet boundaries', () => {
    const enc = new TextEncoder();
    // 'é' is U+00E9, encoded as 2 UTF-8 bytes.
    // 38 × 'é' = 76 octets → must fold at octet 75.
    const line = 'é'.repeat(40); // 80 octets, definitely needs folding
    const folded = foldLine(line);
    const physicalLines = folded.split('\r\n');
    // Every physical line must be ≤ 75 UTF-8 octets
    for (const physLine of physicalLines) {
      expect(enc.encode(physLine).length).toBeLessThanOrEqual(75);
    }
    // Unfolding (strip CRLF + leading space) must reproduce original
    const unfolded = folded.replace(/\r\n /g, '');
    expect(unfolded).toBe(line);
  });

  it('folds emoji (🎉 = 4 bytes) at octet boundaries without splitting surrogates', () => {
    const enc = new TextEncoder();
    // '🎉' is U+1F389, encoded as 4 UTF-8 bytes and represented as a
    // surrogate pair in UTF-16. Old code could split the pair.
    // 20 × '🎉' = 80 octets → needs at least one fold
    const line = '🎉'.repeat(20);
    const folded = foldLine(line);
    const physicalLines = folded.split('\r\n');
    // Every physical line ≤ 75 UTF-8 octets
    for (const physLine of physicalLines) {
      expect(enc.encode(physLine).length).toBeLessThanOrEqual(75);
    }
    // Unfolding must reproduce original (proves no half-codepoint was emitted)
    const unfolded = folded.replace(/\r\n /g, '');
    expect(unfolded).toBe(line);
  });

  it('folds a long mixed-script line crossing two boundaries', () => {
    const enc = new TextEncoder();
    // Mix of ASCII (1 byte), é (2 bytes), and 🎉 (4 bytes) — long enough for
    // at least two fold points
    const line = 'A'.repeat(20) + 'é'.repeat(20) + '🎉'.repeat(10) + 'B'.repeat(20);
    // byte count: 20 + 40 + 40 + 20 = 120 → two folds needed
    const folded = foldLine(line);
    const physicalLines = folded.split('\r\n');
    expect(physicalLines.length).toBeGreaterThanOrEqual(2);
    for (const physLine of physicalLines) {
      expect(enc.encode(physLine).length).toBeLessThanOrEqual(75);
    }
    const unfolded = folded.replace(/\r\n /g, '');
    expect(unfolded).toBe(line);
  });

  it('pure-ASCII line of exactly 75 chars is returned unchanged', () => {
    const line = 'X'.repeat(75);
    expect(foldLine(line)).toBe(line);
  });

  it('pure-ASCII 76-char line still folds at char 75 (ASCII = 1 byte)', () => {
    const line = 'X'.repeat(76);
    expect(foldLine(line)).toBe('X'.repeat(75) + '\r\n ' + 'X');
  });
});

// ---------------------------------------------------------------------------
// contentLine
// ---------------------------------------------------------------------------

describe('contentLine', () => {
  it('produces NAME:VALUE\\r\\n for short content', () => {
    expect(contentLine('SUMMARY', 'Hello')).toBe('SUMMARY:Hello\r\n');
  });

  it('folds and ends with \\r\\n for long content', () => {
    const value = 'X'.repeat(80);
    const result = contentLine('SUMMARY', value);
    expect(result.endsWith('\r\n')).toBe(true);
    expect(result.includes('\r\n ')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatAllDayDtstart
// ---------------------------------------------------------------------------

describe('formatAllDayDtstart', () => {
  it('formats YYYY-MM-DD as VALUE=DATE', () => {
    expect(formatAllDayDtstart('2025-06-17')).toBe('DTSTART;VALUE=DATE:20250617');
  });

  it('works for month boundaries', () => {
    expect(formatAllDayDtstart('2025-01-01')).toBe('DTSTART;VALUE=DATE:20250101');
  });
});

// ---------------------------------------------------------------------------
// formatTimedDtstart
// ---------------------------------------------------------------------------

describe('formatTimedDtstart', () => {
  it('formats ISO datetime with Z suffix unchanged', () => {
    expect(formatTimedDtstart('2025-06-17T08:00:00Z')).toBe('DTSTART:20250617T080000Z');
  });

  it('converts positive offset to true UTC (08:00+05:00 → 03:00Z)', () => {
    // 08:00 local in +05:00 = 03:00 UTC
    expect(formatTimedDtstart('2025-06-17T08:00:00+05:00')).toBe('DTSTART:20250617T030000Z');
  });

  it('converts negative offset to true UTC (08:00-04:00 → 12:00Z)', () => {
    // 08:00 local in -04:00 = 12:00 UTC
    expect(formatTimedDtstart('2025-06-17T08:00:00-04:00')).toBe('DTSTART:20250617T120000Z');
  });

  it('handles already-compact UTC string', () => {
    expect(formatTimedDtstart('20250617T080000Z')).toBe('DTSTART:20250617T080000Z');
  });

  it('converts offset that crosses a date boundary (23:00+05:00 → previous day)', () => {
    // 2025-06-17T23:00:00+05:00 = 2025-06-17T18:00:00Z
    expect(formatTimedDtstart('2025-06-17T23:00:00+05:00')).toBe('DTSTART:20250617T180000Z');
  });

  it('treats floating datetime (no offset, no Z) as UTC without conversion', () => {
    // No offset → floating local time, treated as UTC per documented fallback
    expect(formatTimedDtstart('2025-06-17T08:00:00')).toBe('DTSTART:20250617T080000Z');
  });

  it('preserves trailing-Z datetime exactly (no double Z or conversion)', () => {
    expect(formatTimedDtstart('2025-01-05T09:02:03Z')).toBe('DTSTART:20250105T090203Z');
  });
});

// ---------------------------------------------------------------------------
// formatDtstamp
// ---------------------------------------------------------------------------

describe('formatDtstamp', () => {
  it('produces UTC YYYYMMDDTHHmmssZ format', () => {
    const d = new Date('2025-06-17T10:30:45Z');
    expect(formatDtstamp(d)).toBe('20250617T103045Z');
  });

  it('pads single-digit months and days', () => {
    const d = new Date('2025-01-05T09:02:03Z');
    expect(formatDtstamp(d)).toBe('20250105T090203Z');
  });
});

// ---------------------------------------------------------------------------
// buildVEvent
// ---------------------------------------------------------------------------

describe('buildVEvent — all-day', () => {
  const now = new Date('2025-06-17T00:00:00Z');

  it('contains BEGIN:VEVENT and END:VEVENT', () => {
    const v = buildVEvent({ uid: 'test@fp', summary: 'Test', description: '', date: '2025-06-17', rrule: null, dtstamp: now });
    expect(v).toContain('BEGIN:VEVENT\r\n');
    expect(v).toContain('END:VEVENT\r\n');
  });

  it('contains correct UID', () => {
    const v = buildVEvent({ uid: 'abc123@fairplay-skylight', summary: 'Test', description: '', date: '2025-06-17', rrule: null, dtstamp: now });
    expect(v).toContain('UID:abc123@fairplay-skylight\r\n');
  });

  it('contains VALUE=DATE DTSTART for all-day', () => {
    const v = buildVEvent({ uid: 'x@fp', summary: 'Test', description: '', date: '2025-06-17', rrule: null, dtstamp: now });
    expect(v).toContain('DTSTART;VALUE=DATE:20250617\r\n');
  });

  it('does NOT contain VALUE=DATE when datetime is provided', () => {
    const v = buildVEvent({ uid: 'x@fp', summary: 'Test', description: '', date: '2025-06-17', datetime: '2025-06-17T08:00:00Z', rrule: null, dtstamp: now });
    expect(v).not.toContain('VALUE=DATE');
    expect(v).toContain('DTSTART:20250617T080000Z\r\n');
  });

  it('contains SUMMARY', () => {
    const v = buildVEvent({ uid: 'x@fp', summary: 'Take out trash', description: '', date: '2025-06-17', rrule: null, dtstamp: now });
    expect(v).toContain('SUMMARY:Take out trash\r\n');
  });

  it('escapes special chars in SUMMARY', () => {
    const v = buildVEvent({ uid: 'x@fp', summary: 'Milk, eggs; bread', description: '', date: '2025-06-17', rrule: null, dtstamp: now });
    // Spaces are preserved; only , and ; are escaped
    expect(v).toContain('SUMMARY:Milk\\, eggs\\; bread\r\n');
  });

  it('includes DESCRIPTION when non-empty', () => {
    const v = buildVEvent({ uid: 'x@fp', summary: 'Test', description: 'Notes here', date: '2025-06-17', rrule: null, dtstamp: now });
    expect(v).toContain('DESCRIPTION:Notes here\r\n');
  });

  it('omits DESCRIPTION line when description is empty', () => {
    const v = buildVEvent({ uid: 'x@fp', summary: 'Test', description: '', date: '2025-06-17', rrule: null, dtstamp: now });
    expect(v).not.toContain('DESCRIPTION:');
  });

  it('includes RRULE when provided', () => {
    const v = buildVEvent({ uid: 'x@fp', summary: 'Test', description: '', date: '2025-06-17', rrule: 'FREQ=DAILY;INTERVAL=1', dtstamp: now });
    expect(v).toContain('RRULE:FREQ=DAILY;INTERVAL=1\r\n');
  });

  it('omits RRULE when null', () => {
    const v = buildVEvent({ uid: 'x@fp', summary: 'Test', description: '', date: '2025-06-17', rrule: null, dtstamp: now });
    expect(v).not.toContain('RRULE:');
  });

  it('includes X-FP-RECUR when fpRecur is provided', () => {
    const v = buildVEvent({ uid: 'x@fp', summary: 'Test', description: '', date: '2025-06-17', rrule: 'FREQ=WEEKLY;INTERVAL=1', fpRecur: 'every week', dtstamp: now });
    expect(v).toContain('X-FP-RECUR:every week\r\n');
  });

  it('uses CRLF line endings throughout', () => {
    const v = buildVEvent({ uid: 'x@fp', summary: 'Test', description: '', date: '2025-06-17', rrule: null, dtstamp: now });
    // Every line must end with \r\n (no bare \n)
    const lines = v.split('\r\n');
    // Last element after split of trailing \r\n is empty string — that's fine
    expect(lines[lines.length - 1]).toBe('');
    // None of the content lines should contain a bare \n
    for (const line of lines.slice(0, -1)) {
      expect(line).not.toContain('\n');
    }
  });
});

// ---------------------------------------------------------------------------
// buildVCalendar
// ---------------------------------------------------------------------------

describe('buildVCalendar', () => {
  it('wraps events in BEGIN/END VCALENDAR', () => {
    const cal = buildVCalendar({ calName: 'Test', vevents: [] });
    expect(cal).toContain('BEGIN:VCALENDAR\r\n');
    expect(cal).toContain('END:VCALENDAR\r\n');
  });

  it('includes VERSION:2.0', () => {
    const cal = buildVCalendar({ calName: 'Test', vevents: [] });
    expect(cal).toContain('VERSION:2.0\r\n');
  });

  it('includes CALSCALE:GREGORIAN', () => {
    const cal = buildVCalendar({ calName: 'Test', vevents: [] });
    expect(cal).toContain('CALSCALE:GREGORIAN\r\n');
  });

  it('includes PRODID', () => {
    const cal = buildVCalendar({ calName: 'Test', vevents: [] });
    expect(cal).toContain('PRODID:');
  });

  it('includes X-WR-CALNAME with escaped value', () => {
    const cal = buildVCalendar({ calName: "Amy's Chores", vevents: [] });
    expect(cal).toContain("X-WR-CALNAME:Amy's Chores\r\n");
  });

  it('embeds VEVENT blocks in order', () => {
    const v1 = 'BEGIN:VEVENT\r\nSUMMARY:First\r\nEND:VEVENT\r\n';
    const v2 = 'BEGIN:VEVENT\r\nSUMMARY:Second\r\nEND:VEVENT\r\n';
    const cal = buildVCalendar({ calName: 'Test', vevents: [v1, v2] });
    const idx1 = cal.indexOf('First');
    const idx2 = cal.indexOf('Second');
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
  });

  it('allows custom PRODID', () => {
    const cal = buildVCalendar({ calName: 'Test', prodId: '-//Custom//EN', vevents: [] });
    expect(cal).toContain('PRODID:-//Custom//EN\r\n');
  });
});
