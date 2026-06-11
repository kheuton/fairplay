import type { FpMeta } from './types';

const FP_PREFIX = 'FP::';

/** Split a raw Todoist description into clean text + parsed FpMeta. */
export function parseFp(description: string): { meta: FpMeta; clean: string } {
  if (!description) return { meta: {}, clean: '' };
  const lines = description.split('\n');
  const last = lines[lines.length - 1];
  if (last.startsWith(FP_PREFIX)) {
    const clean = lines.slice(0, -1).join('\n');
    try {
      const parsed: unknown = JSON.parse(last.slice(FP_PREFIX.length));
      // Guard against valid JSON that isn't an object (e.g. null, arrays, primitives)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { meta: parsed as FpMeta, clean };
      }
    } catch {
      // malformed json — treat as no meta
    }
  }
  return { meta: {}, clean: description };
}

/** Serialize clean description + FpMeta back to a Todoist description string.
 *  When meta is empty ({}) the FP:: line is omitted. */
export function withFp(clean: string, meta: FpMeta): string {
  const isEmpty = Object.keys(meta).length === 0;
  if (isEmpty) return clean;
  const metaLine = `${FP_PREFIX}${JSON.stringify(meta)}`;
  return clean ? `${clean}\n${metaLine}` : metaLine;
}
