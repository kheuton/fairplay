/**
 * FAIRPLAY · charter.ts
 * Pure module for parsing and serializing Card Charter data.
 * A charter holds the four FP fields: MSC + CPE (Conception/Planning/Execution).
 * Charter content lives in the clean description of the FP-charter carrier task,
 * stored as markdown sections.
 */

import type { FpTask } from './types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CharterFields {
  msc: string;
  conception: string;
  planning: string;
  execution: string;
}

// ─── parseCharter ─────────────────────────────────────────────────────────────

const SECTION_HEADERS: Record<keyof CharterFields, string> = {
  msc:        '## Minimum Standard of Care',
  conception: '## Conception',
  planning:   '## Planning',
  execution:  '## Execution',
};

// Order matters for parsing: we scan in this order
const FIELD_ORDER: (keyof CharterFields)[] = ['msc', 'conception', 'planning', 'execution'];

/**
 * Parse a markdown description (FP:: line already stripped) into CharterFields.
 * Sections are headed by '## <Name>'. Missing sections produce ''.
 * Robust to extra whitespace or unknown content between sections.
 */
export function parseCharter(description: string): CharterFields {
  const fields: CharterFields = { msc: '', conception: '', planning: '', execution: '' };
  if (!description.trim()) return fields;

  // Build a map of header text → field key for quick lookup
  const headerToKey = new Map<string, keyof CharterFields>();
  for (const key of FIELD_ORDER) {
    headerToKey.set(SECTION_HEADERS[key].toLowerCase(), key);
  }

  const lines = description.split('\n');
  let currentKey: keyof CharterFields | null = null;
  const buckets: Record<keyof CharterFields, string[]> = {
    msc: [], conception: [], planning: [], execution: [],
  };

  for (const line of lines) {
    const normalized = line.trimEnd();
    const trimmed = normalized.trim();

    // Check if this line is a known section header
    const matchedKey = headerToKey.get(trimmed.toLowerCase());
    if (matchedKey !== undefined) {
      currentKey = matchedKey;
      continue;
    }

    if (currentKey !== null) {
      buckets[currentKey].push(normalized);
    }
  }

  for (const key of FIELD_ORDER) {
    // Trim trailing blank lines but preserve internal whitespace
    let content = buckets[key].join('\n');
    content = content.replace(/\n+$/, '');
    // Also trim leading blank line that follows the header
    content = content.replace(/^\n+/, '');
    fields[key] = content;
  }

  return fields;
}

// ─── serializeCharter ─────────────────────────────────────────────────────────

/**
 * Serialize CharterFields back to a markdown string.
 * Skips sections whose value is empty (no header emitted).
 * Sections that have content are separated by a blank line.
 */
export function serializeCharter(fields: CharterFields): string {
  const parts: string[] = [];
  for (const key of FIELD_ORDER) {
    const value = fields[key].trim();
    if (!value) continue;
    parts.push(`${SECTION_HEADERS[key]}\n${value}`);
  }
  return parts.join('\n\n');
}

// ─── detectConceptTasks ────────────────────────────────────────────────────────

/**
 * Regex that matches a task content beginning with a known phase label followed
 * immediately by a colon or dash (with optional surrounding whitespace).
 * Requires the colon/dash so that 'Planning the trip' is NOT matched but
 * 'Planning: book flights' IS matched.
 */
const CONCEPT_PATTERN = /^(minimum standard of care|conception|planning|execution)\s*[:\-]/i;

/** Maps a matched label to the CharterFields key it feeds into. */
function labelToKey(label: string): keyof CharterFields {
  const l = label.toLowerCase();
  if (l.startsWith('minimum')) return 'msc';
  if (l.startsWith('conception')) return 'conception';
  if (l.startsWith('planning')) return 'planning';
  return 'execution';
}

export interface ConceptTaskMatch {
  field: keyof CharterFields;
  task: FpTask;
}

/**
 * Find tasks whose content looks like one of the seeded template concept tasks.
 * Matches: /^(minimum standard of care|conception|planning|execution)\s*[:\-]/i
 * Returns one entry per matched task with the target charter field.
 */
export function detectConceptTasks(tasks: FpTask[]): ConceptTaskMatch[] {
  const results: ConceptTaskMatch[] = [];
  for (const task of tasks) {
    const m = CONCEPT_PATTERN.exec(task.content);
    if (m) {
      results.push({ field: labelToKey(m[1]), task });
    }
  }
  return results;
}

// ─── absorbText ────────────────────────────────────────────────────────────────

/**
 * Extract the text to absorb from a concept task into a charter field.
 * Strips the '<Phase>:' or '<Phase> -' prefix from the content.
 * Appends the task's clean description on a new line when non-empty.
 */
export function absorbText(task: FpTask): string {
  // Strip the leading phase prefix (e.g. "Planning: " or "Conception - ")
  const stripped = task.content.replace(CONCEPT_PATTERN, (_, label) => {
    // Remove the label + separator; trim remaining
    return '';
  }).replace(/^[\s:\-]+/, '').trim();

  const desc = (task.description ?? '').trim();
  if (desc) {
    return stripped ? `${stripped}\n${desc}` : desc;
  }
  return stripped;
}
