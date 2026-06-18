/**
 * FP:: metadata parser for the Skylight Sync Worker.
 *
 * MIRRORS: worker/skylight-ics/src/metadata.ts
 *
 * Kept as a self-contained copy so the Worker has no cross-package dependency.
 */

const FP_PREFIX = 'FP::';

export interface FpMeta {
  /** FairPlay stable id — survives Todoist task id reuse */
  id?: string;
  /** Profile / owner of this card */
  profile?: string;
  [key: string]: unknown;
}

/**
 * Split a raw Todoist description into clean text + parsed FP metadata.
 * The app stores metadata as a final description line "FP::{json}".
 * Returns clean = everything before that line (or the full text if no FP:: line).
 */
export function parseFp(description: string): { meta: FpMeta; clean: string } {
  if (!description) return { meta: {}, clean: '' };
  const lines = description.split('\n');
  const last = lines[lines.length - 1];
  if (last.startsWith(FP_PREFIX)) {
    const clean = lines.slice(0, -1).join('\n');
    try {
      const parsed: unknown = JSON.parse(last.slice(FP_PREFIX.length));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { meta: parsed as FpMeta, clean };
      }
    } catch {
      // malformed JSON — treat as no meta
    }
  }
  return { meta: {}, clean: description };
}
