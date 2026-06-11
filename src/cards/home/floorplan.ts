/**
 * FAIRPLAY · Home Maintenance · Floorplan Data
 *
 * Edit the rooms array below to match your actual house.
 * Each room is an axis-aligned rectangle in the 560×330 SVG viewBox.
 * - id:    unique slug (matches meta.zone on tasks)
 * - label: display name (appears as mono label in the blueprint)
 * - x, y:  top-left corner in viewBox units
 * - w, h:  width and height in viewBox units
 *
 * Door arcs are defined separately — edit doorArcs to add/remove
 * door-swing flavour lines for specific rooms.
 *
 * Exterior zones (ROOF/ATTIC, YARD/EXTERIOR) are thin edge bands;
 * edit them the same way as interior rooms.
 */

export interface Room {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Edge/exterior zone (rendered differently — thin hatched band). */
  exterior?: boolean;
}

/**
 * A door-swing arc for flavor.
 * cx/cy = hinge point, r = radius, startAngle/endAngle in degrees (0=right, 90=down).
 */
export interface DoorArc {
  cx: number;
  cy: number;
  r: number;
  startAngle: number;
  endAngle: number;
}

// ---------------------------------------------------------------------------
// ROOMS — edit these to match your house.
// Outer wall boundary: x=28..532, y=28..302  (inner face of the double-line wall)
// Interior grid: 560 × 330 viewBox
// ---------------------------------------------------------------------------

export const ROOMS: Room[] = [
  // ── Main floor ──────────────────────────────────────────────────────────

  // Kitchen: upper-left quadrant
  { id: 'kitchen',  label: 'KITCHEN',       x:  28, y:  28, w: 148, h: 110 },

  // Dining: right of kitchen
  { id: 'dining',   label: 'DINING',         x: 176, y:  28, w: 128, h: 110 },

  // Living: spans most of the right side, main floor
  { id: 'living',   label: 'LIVING',         x: 304, y:  28, w: 228, h: 110 },

  // ── Lower floor ─────────────────────────────────────────────────────────

  // Primary bedroom: lower-left
  { id: 'bed1',     label: 'BED 1',          x:  28, y: 138, w: 148, h: 100 },

  // Second bedroom: next to primary
  { id: 'bed2',     label: 'BED 2',          x: 176, y: 138, w: 128, h: 100 },

  // Bathroom: center
  { id: 'bath',     label: 'BATH',           x: 304, y: 138, w:  80, h: 100 },

  // Laundry: right of bath
  { id: 'laundry',  label: 'LAUNDRY',        x: 384, y: 138, w:  72, h: 100 },

  // Garage: far right
  { id: 'garage',   label: 'GARAGE',         x: 456, y: 138, w:  76, h: 100 },

  // ── Utility strip ───────────────────────────────────────────────────────

  // Utility / HVAC: thin strip below lower floor
  { id: 'utility',  label: 'UTILITY · HVAC', x:  28, y: 238, w: 504, h:  64 },

  // ── Exterior bands ──────────────────────────────────────────────────────

  // Roof / Attic: thin top band
  { id: 'roof',     label: 'ROOF · ATTIC',   x:   0, y:   0, w: 560, h:  22, exterior: true },

  // Yard / Exterior: thin bottom band
  { id: 'yard',     label: 'YARD · EXTERIOR', x:  0, y: 308, w: 560, h:  22, exterior: true },
];

// ---------------------------------------------------------------------------
// DOOR ARCS — edit/add to match actual door positions and swing directions.
// ---------------------------------------------------------------------------

export const DOOR_ARCS: DoorArc[] = [
  // Kitchen door (swings into kitchen from dining side)
  { cx: 176, cy:  68, r: 22, startAngle: 0,   endAngle: 90  },
  // Bed 1 door (swings into bed 1)
  { cx: 176, cy: 178, r: 22, startAngle: 0,   endAngle: 90  },
  // Bed 2 door (swings outward into hall)
  { cx: 304, cy: 188, r: 20, startAngle: 180, endAngle: 270 },
  // Bath door
  { cx: 304, cy: 198, r: 18, startAngle: 270, endAngle: 360 },
  // Laundry door
  { cx: 384, cy: 168, r: 18, startAngle: 90,  endAngle: 180 },
  // Garage door (main entry arc)
  { cx: 456, cy: 218, r: 24, startAngle: 0,   endAngle: 90  },
];
