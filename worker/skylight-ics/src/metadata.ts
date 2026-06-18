/**
 * FP:: metadata parser for the Skylight ICS Worker.
 *
 * MIRRORS: src/lib/metadata.ts (parseFp)
 *
 * Kept as a self-contained copy so the Worker has no cross-package dependency.
 * Only parseFp is needed (we never write back).
 */

const FP_PREFIX = 'FP::';

/**
 * Split a raw Todoist description into clean text + parsed FP metadata.
 * The app stores metadata as a final description line "FP::{json}".
 * Returns clean = everything before that line (or the full text if no FP:: line).
 */
export function parseFp(description: string): { meta: Record<string, unknown>; clean: string } {
  if (!description) return { meta: {}, clean: '' };
  const lines = description.split('\n');
  const last = lines[lines.length - 1];
  if (last.startsWith(FP_PREFIX)) {
    const clean = lines.slice(0, -1).join('\n');
    try {
      const parsed: unknown = JSON.parse(last.slice(FP_PREFIX.length));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { meta: parsed as Record<string, unknown>, clean };
      }
    } catch {
      // malformed JSON — treat as no meta
    }
  }
  return { meta: {}, clean: description };
}
