/**
 * RFC-5545 iCalendar builder for the Skylight ICS Worker.
 *
 * Responsibilities:
 *   • Escape TEXT values (commas, semicolons, backslashes, newlines)
 *   • Fold lines that exceed 75 octets (RFC 5545 §3.1)
 *   • Produce VCALENDAR + VEVENT blocks with CRLF line endings
 *   • Format DTSTART for all-day (VALUE=DATE) vs timed (UTC "Z") events
 *   • Format DTSTAMP as UTC
 *
 * NOTE on DST: Todoist's due.datetime is stored in the task's configured
 * timezone. When we parse it as UTC (appending "Z") the time will be off
 * by the UTC offset of that timezone. For Skylight calendar display this is
 * acceptable (the chore still appears on the correct date), but if precise
 * time matters the caller should convert to UTC using the task's timezone.
 * This limitation is documented in X-FP-TZ-NOTE on timed events.
 */

// ---------------------------------------------------------------------------
// Escaping & folding
// ---------------------------------------------------------------------------

/**
 * Escape a TEXT property value per RFC 5545 §3.3.11.
 * Escapes: backslash → \\, semicolon → \;, comma → \,, newline → \n
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold a single content line to comply with RFC 5545 §3.1 line-length limits.
 * Lines are folded at 75 octets (UTF-8 bytes), with each continuation line
 * beginning with a single space (CRLF + SP).
 *
 * Iteration is by Unicode code point (spread/for-of), never by UTF-16 code
 * unit, so surrogate pairs (e.g. emoji) are never split across a fold boundary.
 * Each continuation line's leading space counts toward the 75-octet budget, so
 * each continuation chunk holds at most 74 octets of content.
 */

const _enc = new TextEncoder();

/** Return the UTF-8 byte length of a single Unicode code point string. */
function _cpBytes(cp: string): number {
  return _enc.encode(cp).length;
}

export function foldLine(line: string): string {
  // Fast path: ASCII-only lines that fit in 75 bytes
  if (line.length <= 75 && _enc.encode(line).length <= 75) return line;

  const parts: string[] = [];
  let chunk = '';
  let chunkBytes = 0;
  // First physical line budget: 75 octets. Continuation: 74 (the leading SP
  // takes 1 octet, which is accounted for when we prepend it below).
  let budget = 75;

  for (const cp of line) {
    const cpLen = _cpBytes(cp);
    if (chunkBytes + cpLen > budget) {
      // Flush the current chunk and start a continuation line
      parts.push(chunk);
      chunk = ' ' + cp; // leading SP + first code point of new chunk
      chunkBytes = 1 + cpLen; // 1 for the SP
      budget = 75; // continuation lines also have a 75-octet physical limit
      // (leading SP uses 1 octet, leaving 74 for content — enforced above)
    } else {
      chunk += cp;
      chunkBytes += cpLen;
    }
  }

  if (chunk.length > 0) parts.push(chunk);

  return parts.join('\r\n');
}

/**
 * Produce a CRLF-terminated, folded content line.
 * `name` is the property name (e.g. "SUMMARY"), `value` is already-escaped.
 */
export function contentLine(name: string, value: string): string {
  return foldLine(`${name}:${value}`) + '\r\n';
}

// ---------------------------------------------------------------------------
// Date/time formatting
// ---------------------------------------------------------------------------

/**
 * Format a YYYY-MM-DD date string as an all-day DTSTART property.
 * Returns the property name+params+colon+value WITHOUT trailing CRLF
 * so callers can pass it directly to contentLine or embed it in a block.
 *
 * Returns: "DTSTART;VALUE=DATE:YYYYMMDD"
 */
export function formatAllDayDtstart(date: string): string {
  // date = "YYYY-MM-DD"
  const compact = date.replace(/-/g, '');
  return `DTSTART;VALUE=DATE:${compact}`;
}

/**
 * Format an ISO 8601 datetime string as a UTC timed DTSTART.
 *
 * Three cases:
 *   1. String ends with 'Z'          — already UTC; format directly.
 *   2. String carries a numeric offset (+HH:MM / -HH:MM) — parse with
 *      new Date() which respects the offset, then emit the true UTC instant
 *      via formatDtstamp().  Example: "2025-06-17T08:00:00+05:00" →
 *      "DTSTART:20250617T030000Z" (08:00 minus 5 h = 03:00 UTC).
 *   3. No offset and no Z (floating local time) — treated as UTC by
 *      appending 'Z' without conversion (see DST caveat in module header).
 *
 * Returns: "DTSTART:YYYYMMDDTHHmmssZ"
 */
export function formatTimedDtstart(datetime: string): string {
  const dt = datetime.trim();

  // Case 1: already a UTC literal (ends with Z)
  if (dt.endsWith('Z')) {
    // Strip punctuation only: "2025-06-17T08:00:00Z" → "20250617T080000Z"
    const compact = dt.replace(/-/g, '').replace(/:/g, '');
    return `DTSTART:${compact}`;
  }

  // Case 2: numeric UTC offset present (+HH:MM or -HH:MM at end)
  const hasOffset = /[+-]\d{2}:\d{2}$/.test(dt);
  if (hasOffset) {
    // new Date() fully respects the offset and gives us the correct UTC instant
    const utcStamp = formatDtstamp(new Date(dt));
    return `DTSTART:${utcStamp}`;
  }

  // Case 3: floating local time — no offset, no Z.
  // Treat as UTC (documented limitation; DST offset not applied).
  const compact = dt.replace(/-/g, '').replace(/:/g, '') + 'Z';
  return `DTSTART:${compact}`;
}

/**
 * Format a Date object as a UTC DTSTAMP string: "YYYYMMDDTHHmmssZ"
 */
export function formatDtstamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    String(date.getUTCFullYear()) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    'T' +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  );
}

// ---------------------------------------------------------------------------
// VEVENT builder
// ---------------------------------------------------------------------------

export interface VEventParams {
  uid: string;
  summary: string;
  description: string;
  /** YYYY-MM-DD all-day date */
  date: string;
  /** ISO datetime (with or without timezone) — if provided, overrides all-day */
  datetime?: string;
  /** RFC-5545 RRULE value string (without "RRULE:" prefix), or null */
  rrule: string | null;
  /** Original Todoist due.string, stored in X-FP-RECUR for traceability */
  fpRecur?: string;
  dtstamp?: Date;
}

/**
 * Build a VEVENT block (CRLF-terminated).
 */
export function buildVEvent(params: VEventParams): string {
  const {
    uid,
    summary,
    description,
    date,
    datetime,
    rrule,
    fpRecur,
    dtstamp = new Date(),
  } = params;

  const parts: string[] = [];

  parts.push('BEGIN:VEVENT\r\n');

  // UID — stable per task
  parts.push(contentLine('UID', escapeText(uid)));

  // DTSTAMP — time this ICS was generated (UTC)
  parts.push(contentLine('DTSTAMP', formatDtstamp(dtstamp)));

  // DTSTART — all-day or timed.
  // Both formatAllDayDtstart and formatTimedDtstart return a complete property
  // name+params+colon+value string; we fold and append CRLF directly.
  if (datetime) {
    parts.push(foldLine(formatTimedDtstart(datetime)) + '\r\n');
    // Only warn for genuinely floating datetimes (no Z, no numeric offset).
    // Offset-bearing datetimes are correctly converted to UTC by formatTimedDtstart.
    const dtTrimmed = datetime.trim();
    const isFloating = !dtTrimmed.endsWith('Z') && !/[+-]\d{2}:\d{2}$/.test(dtTrimmed);
    if (isFloating) {
      parts.push(contentLine('X-FP-TZ-NOTE', 'Floating local time treated as UTC; DST offset not applied'));
    }
  } else {
    parts.push(foldLine(formatAllDayDtstart(date)) + '\r\n');
  }

  // SUMMARY
  parts.push(contentLine('SUMMARY', escapeText(summary)));

  // DESCRIPTION
  if (description) {
    parts.push(contentLine('DESCRIPTION', escapeText(description)));
  }

  // RRULE
  if (rrule) {
    parts.push(contentLine('RRULE', rrule));
  }

  // X-FP-RECUR — traceability: the original Todoist due.string
  if (fpRecur) {
    parts.push(contentLine('X-FP-RECUR', escapeText(fpRecur)));
  }

  parts.push('END:VEVENT\r\n');

  return parts.join('');
}

// ---------------------------------------------------------------------------
// VCALENDAR wrapper
// ---------------------------------------------------------------------------

export interface VCalendarParams {
  calName: string;
  prodId?: string;
  vevents: string[];
}

/**
 * Wrap VEVENT blocks in a VCALENDAR envelope (CRLF throughout).
 */
export function buildVCalendar(params: VCalendarParams): string {
  const {
    calName,
    prodId = '-//FairPlay Skylight//ICS Feed//EN',
    vevents,
  } = params;

  const header = [
    'BEGIN:VCALENDAR\r\n',
    contentLine('VERSION', '2.0'),
    contentLine('PRODID', prodId),
    contentLine('CALSCALE', 'GREGORIAN'),
    contentLine('X-WR-CALNAME', escapeText(calName)),
  ].join('');

  const footer = 'END:VCALENDAR\r\n';

  return header + vevents.join('') + footer;
}
