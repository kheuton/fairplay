/**
 * FAIRPLAY · Home Maintenance · Floorplan Data
 *
 * This is the data-driven blueprint for THE APARTMENT — the 2nd level of a
 * north–south triple-decker (longer than it is wide). North is at the TOP of
 * the viewBox. Everything the blueprint renders comes from this file; edit the
 * coordinates here to nudge the layout and the SVG follows.
 *
 * Coordinate system
 * -----------------
 *   viewBox: 0 0 520 940   (portrait — taller than wide, like the unit)
 *   Outer wall outer face : x 10..510, y 10..910   (rect 10,10,500,900)
 *   Outer wall inner face : x 24..496, y 24..896   (rect 24,24,472,872)
 *   Interior usable band  : x 24..496 (width 472) × y 24..896 (height 872)
 *
 * Two levels
 * ----------
 *   'main'      — the apartment floor (all rooms below)
 *   'basement'  — shared basement (bikes, scooter, coin-op laundry)
 * The HomeView renders one level at a time via a level toggle. Both levels use
 * the same viewBox.
 *
 * Rooms vs Fixtures
 * -----------------
 *   Room    — a task ZONE. Clickable; tasks bind via meta.zone === room.id.
 *             Drawn as a bordered rectangle with a label + task pip.
 *   Fixture — furniture / appliance. Decorative (not a task zone). Drawn as a
 *             rect or polygon symbol with a small label.
 *
 * The water filter is a special fixture (variant 'filter'): the HomeView draws a
 * live health ring on it and clicking it opens the filter wireframe panel.
 */

export type LevelId = 'main' | 'basement';

export const VIEWBOX = { w: 520, h: 940 } as const;

/**
 * Outer wall faces. The north (front) facade has TWO half-hexagon (canted) bay
 * windows — one for the entry, one for the master bedroom — that meet at the
 * party wall between them (x=272). Each bay reads as: wall → slant out → flat
 * front → slant back → wall. The other three sides are straight. The renderer
 * draws the double-line wall from the two polygons; the outer/inner rects are
 * kept for the bounding box the dimension lines + title block reference.
 */
export const OUTER_WALL = {
  outer: { x: 10, y: 10, w: 500, h: 900 },
  inner: { x: 24, y: 24, w: 472, h: 872 },
  // W→E: NW corner · [entry bay: slant, flat, slant to party wall] · [master bay:
  // slant, flat, slant] · NE corner · then straight E / S / W sides.
  outerPoly: [[10, 44], [44, 12], [252, 12], [272, 44], [292, 12], [476, 12], [510, 44], [510, 910], [10, 910]] as Array<[number, number]>,
  innerPoly: [[24, 58], [44, 26], [252, 26], [272, 58], [292, 26], [476, 26], [496, 58], [496, 896], [24, 896]] as Array<[number, number]>,
};

/** A bay-window flourish projecting north (up) from a wall. */
export interface Bay {
  /** span start along the wall (viewBox x) */
  x0: number;
  /** span end along the wall (viewBox x) */
  x1: number;
  /** base line y (the inner wall the bay sits on) */
  y: number;
  /** how far the bay projects north, in viewBox units (e.g. 12) */
  depth: number;
  /** number of window panes / mullions (default 3) */
  panes?: number;
}

export type FixtureShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number }
  | { kind: 'poly'; points: Array<[number, number]> };

/** Visual styling family for a fixture symbol. */
export type FixtureVariant =
  | 'appliance' // hard rectangular machine (stove, fridge, washer…)
  | 'soft'      // upholstered (couch, chair, recliner)
  | 'storage'   // cabinet/closet/dresser/shelf
  | 'fixture'   // plumbing / counters / tables / desks
  | 'bed'       // beds & cribs (drawn with a pillow line)
  | 'play'      // playpen outline (dashed, no fill)
  | 'filter';   // the tracked water filter (live health ring)

export interface Fixture {
  id: string;
  label?: string;
  level?: LevelId; // default 'main'
  shape: FixtureShape;
  variant: FixtureVariant;
  /** optional sub-labels drawn as small dots inside (e.g. island holds 2 things) */
  items?: string[];
}

export interface Room {
  id: string;
  label: string;
  level?: LevelId; // default 'main'
  x: number;
  y: number;
  w: number;
  h: number;
  /** Not part of the unit (shared stairwell) — hatched, not clickable. */
  void?: boolean;
  /** Exterior-ish band (storage porch) — lighter styling. */
  exterior?: boolean;
  /** Bay windows on this room's north wall. */
  bays?: Bay[];
  /** Optional polygon outline (overrides the x/y/w/h rect for non-rectangular
   *  rooms — the angled front facade, the L-shaped stair void). x/y/w/h still
   *  give the bounding box used for label fallback and the zone <select>. */
  poly?: Array<[number, number]>;
  /** Explicit label / task-pip anchor (defaults to the bounding-box center —
   *  useful for L-shaped rooms whose centroid lands outside the floor). */
  labelX?: number;
  labelY?: number;
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

export interface Level {
  id: LevelId;
  label: string;
  rooms: Room[];
  fixtures: Fixture[];
  doors: DoorArc[];
}

// ===========================================================================
// MAIN LEVEL — the apartment
// ===========================================================================

const MAIN_ROOMS: Room[] = [
  // ── North band (front): Entry (W) + Master bed (E) ─────────────────────────
  // Each front room has its OWN half-hexagon (canted) bay window on the north wall;
  // the two bays meet at the party wall (x=272). See OUTER_WALL. The Entry runs the
  // full depth; the stairs take a bite out of the Master's south, so the Master is
  // shorter than the Entry.
  {
    id: 'office',
    label: 'ENTRY · DESK',
    x: 24, y: 26, w: 248, h: 274, // bbox x:24..272, y:26..300
    labelX: 150, labelY: 245,
    poly: [[24, 58], [44, 26], [252, 26], [272, 58], [272, 300], [24, 300]],
  },
  {
    id: 'master',
    label: 'MASTER BED',
    x: 272, y: 26, w: 224, h: 210, // bbox x:272..496, y:26..236
    labelX: 378, labelY: 120,
    poly: [[272, 58], [292, 26], [476, 26], [496, 58], [496, 236], [272, 236]],
  },

  // ── Shared stairwell — L-shaped void ───────────────────────────────────────
  // Top arm (landing) abuts the Entry with a door into it (x=272); the lower arm
  // runs down the Living room's east edge. Not part of the unit.
  {
    id: 'stair', label: 'STAIR · COMMON', void: true,
    x: 272, y: 236, w: 224, h: 324, // bbox x:272..496, y:236..560
    labelX: 450, labelY: 440,
    poly: [[272, 236], [496, 236], [496, 560], [400, 560], [400, 300], [272, 300]],
  },

  // ── Living band ────────────────────────────────────────────────────────────
  { id: 'living', label: 'LIVING', x: 24, y: 300, w: 376, h: 260 }, // x:24..400

  // ── Bath + narrow Hall band ────────────────────────────────────────────────
  { id: 'bath', label: 'BATH', x: 24, y: 560, w: 238, h: 112 }, // x:24..262
  // The hall is a NARROW corridor connecting the living room down to the kitchen.
  { id: 'hall', label: 'HALL', x: 262, y: 560, w: 74, h: 112 }, // x:262..336

  // ── Kitchen + (taller) Nursery ─────────────────────────────────────────────
  { id: 'kitchen', label: 'KITCHEN', x: 24, y: 672, w: 312, h: 164 }, // x:24..336
  // Nursery is longer — its north edge abuts the stairs / living room (y=560).
  { id: 'nursery', label: 'NURSERY', x: 336, y: 560, w: 160, h: 276, labelX: 416, labelY: 692 }, // x:336..496, y:560..836

  // ── Storage porch (south edge) ────────────────────────────────────────────
  { id: 'porch', label: 'STORAGE · PORCH', x: 24, y: 836, w: 472, h: 60, exterior: true },
];

const MAIN_FIXTURES: Fixture[] = [
  // ── Entry (room poly x:24..272, half-hexagon bay north → full depth to y:300) ──
  // Desk is an irregular (right) trapezoid flush with the bay: its west edge rides
  // the bay's west slant and its north edge sits on the bay's flat front, filling
  // the WESTERN HALF of the north wall (x:24..148). Its two eastern corners are
  // right angles. The bike sits on the eastern half of the bay wall.
  { id: 'desk', label: 'DESK', variant: 'fixture', shape: { kind: 'poly', points: [[44, 26], [148, 26], [148, 58], [24, 58]] } },
  { id: 'bike', label: 'EX BIKE', variant: 'appliance', shape: { kind: 'rect', x: 174, y: 30, w: 74, h: 28 } },
  { id: 'shelf', label: 'SHELF', variant: 'storage', items: ['PRINTER'], shape: { kind: 'rect', x: 28, y: 100, w: 22, h: 70 } },
  // L-shaped sofa-bed against the west wall (pulls out into the guest bed)
  {
    id: 'office-sofa', label: 'SOFA-BED', variant: 'soft',
    shape: { kind: 'poly', points: [[28, 186], [150, 186], [150, 222], [80, 222], [80, 290], [28, 290]] },
  },
  // L-shaped playpen — rotated 90° CW: sits between the desk and the sofa-bed
  // and wraps to the east of the sofa-bed (dashed outline drawn over the floor)
  {
    id: 'office-playpen', label: 'PLAYPEN', variant: 'play',
    shape: { kind: 'poly', points: [[92, 100], [258, 100], [258, 292], [162, 292], [162, 152], [92, 152]] },
  },

  // ── Master bedroom (room poly x:272..496, angled north, south wall y:236) ──
  { id: 'master-dresser', label: 'DRESSER', variant: 'storage', shape: { kind: 'rect', x: 276, y: 92, w: 24, h: 90 } },
  // Closet + AC in the NE corner (closet against the east wall)
  { id: 'master-closet', label: 'CLOSET', variant: 'storage', shape: { kind: 'rect', x: 466, y: 64, w: 26, h: 60 } },
  { id: 'master-ac', label: 'AC', variant: 'appliance', shape: { kind: 'rect', x: 416, y: 32, w: 44, h: 22 } },
  // Bed rotated 90° (long axis N–S) in the SE corner
  { id: 'master-bed', label: 'BED', variant: 'bed', shape: { kind: 'rect', x: 456, y: 150, w: 34, h: 82 } },

  // ── Living room (room x:24..400, y:300..560) ──────────────────────────────
  { id: 'tv', label: 'TV', variant: 'appliance', shape: { kind: 'rect', x: 40, y: 306, w: 72, h: 14 } },
  { id: 'living-chair', label: 'CHAIR', variant: 'soft', shape: { kind: 'rect', x: 52, y: 332, w: 46, h: 40 } },
  { id: 'toy-bench', label: 'TOYS', variant: 'storage', shape: { kind: 'rect', x: 348, y: 306, w: 48, h: 42 } },
  // large L-shaped couch in the southwest
  {
    id: 'living-sofa', label: 'L-SOFA', variant: 'soft',
    shape: { kind: 'poly', points: [[28, 452], [210, 452], [210, 492], [92, 492], [92, 552], [28, 552]] },
  },

  // ── Bathroom (room x:24..230, y:560..672) ─────────────────────────────────
  { id: 'bath-sink', label: 'SINK', variant: 'fixture', shape: { kind: 'rect', x: 30, y: 572, w: 40, h: 26 } },
  { id: 'bath-wc', label: 'WC', variant: 'fixture', shape: { kind: 'rect', x: 172, y: 576, w: 34, h: 44 } },
  { id: 'bath-tub', label: 'TUB', variant: 'fixture', shape: { kind: 'rect', x: 30, y: 634, w: 120, h: 32 } },

  // ── Kitchen (room x:24..330, y:672..836) ──────────────────────────────────
  // West wall stack, N→S: stove · bottle washer · sink (+ filter) · fridge
  { id: 'stove', label: 'STOVE', variant: 'appliance', shape: { kind: 'rect', x: 30, y: 680, w: 64, h: 40 } },
  { id: 'bottle-washer', label: 'BOTTLES', variant: 'appliance', shape: { kind: 'rect', x: 30, y: 726, w: 52, h: 30 } },
  { id: 'kitchen-sink', label: 'SINK', variant: 'fixture', shape: { kind: 'rect', x: 30, y: 762, w: 56, h: 34 } },
  // THE WATER FILTER — tracked component (lives under/beside the sink)
  { id: 'water-filter', label: 'FILTER', variant: 'filter', shape: { kind: 'rect', x: 92, y: 764, w: 24, h: 34 } },
  { id: 'fridge', label: 'FRIDGE', variant: 'appliance', shape: { kind: 'rect', x: 30, y: 800, w: 64, h: 32 } },
  // central: island · dishwasher · table
  { id: 'island', label: 'ISLAND', variant: 'fixture', items: ['VITAMIX', 'PRESSURE'], shape: { kind: 'rect', x: 150, y: 690, w: 110, h: 46 } },
  { id: 'dishwasher', label: 'D/WASH', variant: 'appliance', shape: { kind: 'rect', x: 152, y: 792, w: 96, h: 34 } },
  { id: 'kitchen-table', label: 'TABLE', variant: 'fixture', items: ['RICE', 'AIRFRY'], shape: { kind: 'rect', x: 268, y: 730, w: 56, h: 60 } },

  // ── Nursery (room x:336..496, y:560..836) ─────────────────────────────────
  // Recliner NW corner; monitor-on-arm + cart east of it. Closet NE corner;
  // air filter SE corner. Changing table N–S on the west wall; crib N–S on east.
  { id: 'recliner', label: 'RECLINER', variant: 'soft', shape: { kind: 'rect', x: 342, y: 572, w: 52, h: 46 } },
  { id: 'monitor-arm', label: 'MON', variant: 'fixture', shape: { kind: 'rect', x: 404, y: 572, w: 28, h: 16 } },
  { id: 'nursery-cart', label: 'CART', variant: 'storage', shape: { kind: 'rect', x: 404, y: 596, w: 28, h: 22 } },
  { id: 'nursery-closet', label: 'CLO', variant: 'storage', shape: { kind: 'rect', x: 440, y: 566, w: 50, h: 44 } },
  { id: 'changing-table', label: 'CHANGE', variant: 'storage', shape: { kind: 'rect', x: 340, y: 630, w: 24, h: 120 } },
  { id: 'crib', label: 'CRIB', variant: 'bed', shape: { kind: 'rect', x: 468, y: 628, w: 24, h: 130 } },
  { id: 'air-filter', label: 'AIR', variant: 'appliance', shape: { kind: 'rect', x: 462, y: 794, w: 28, h: 34 } },

  // ── Storage porch (room x:24..496, y:836..896) ────────────────────────────
  { id: 'minifridge', label: 'MINI', variant: 'appliance', shape: { kind: 'rect', x: 32, y: 850, w: 40, h: 36 } },
];

const MAIN_DOORS: DoorArc[] = [
  // Large doorway: entry → living (south wall of the entry)
  { cx: 150, cy: 300, r: 38, startAngle: 270, endAngle: 360 },
  // Stairwell door INTO the entry (west edge of the stair landing, x=272)
  { cx: 272, cy: 264, r: 24, startAngle: 90, endAngle: 180 },
  // Master bedroom door off the stair landing (south wall of master, y=236)
  { cx: 380, cy: 236, r: 24, startAngle: 0, endAngle: 90 },
  // Bath door off the hall (bath east edge, x=262)
  { cx: 262, cy: 602, r: 20, startAngle: 90, endAngle: 180 },
  // Kitchen entry from the hall (hall south edge, y=672)
  { cx: 300, cy: 672, r: 22, startAngle: 180, endAngle: 270 },
  // Nursery door from the hall (nursery west edge, x=336)
  { cx: 336, cy: 612, r: 22, startAngle: 90, endAngle: 180 },
];

// ===========================================================================
// BASEMENT LEVEL — shared (bikes, e-scooter, coin-op laundry)
// ===========================================================================

const BASEMENT_ROOMS: Room[] = [
  { id: 'basement', label: 'BASEMENT · SHARED', level: 'basement', x: 60, y: 120, w: 400, h: 520 },
];

const BASEMENT_FIXTURES: Fixture[] = [
  { id: 'bike-1', label: 'BIKE 1', level: 'basement', variant: 'appliance', shape: { kind: 'rect', x: 90, y: 170, w: 150, h: 30 } },
  { id: 'bike-2', label: 'BIKE 2', level: 'basement', variant: 'appliance', shape: { kind: 'rect', x: 90, y: 212, w: 150, h: 30 } },
  { id: 'bike-3', label: 'BIKE 3', level: 'basement', variant: 'appliance', shape: { kind: 'rect', x: 90, y: 254, w: 150, h: 30 } },
  { id: 'scooter', label: 'E-SCOOTER', level: 'basement', variant: 'appliance', shape: { kind: 'rect', x: 90, y: 308, w: 110, h: 24 } },
  { id: 'washer', label: 'WASHER', level: 'basement', variant: 'appliance', items: ['COIN-OP'], shape: { kind: 'rect', x: 310, y: 180, w: 90, h: 90 } },
  { id: 'dryer', label: 'DRYER', level: 'basement', variant: 'appliance', items: ['COIN-OP'], shape: { kind: 'rect', x: 310, y: 290, w: 90, h: 90 } },
];

// ===========================================================================
// Exports
// ===========================================================================

export const LEVELS: Level[] = [
  { id: 'main', label: 'MAIN FLOOR', rooms: MAIN_ROOMS, fixtures: MAIN_FIXTURES, doors: MAIN_DOORS },
  { id: 'basement', label: 'BASEMENT', rooms: BASEMENT_ROOMS, fixtures: BASEMENT_FIXTURES, doors: [] },
];

export function getLevel(id: LevelId): Level {
  return LEVELS.find((l) => l.id === id) ?? LEVELS[0];
}

/** Every interior (non-void) room across all levels — used for the zone <select>. */
export const ALL_ROOMS: Room[] = LEVELS.flatMap((l) =>
  l.rooms.filter((r) => !r.void).map((r) => ({ ...r, level: r.level ?? l.id }))
);

/** The fixture id of the tracked water filter (special-cased by HomeView). */
export const WATER_FILTER_FIXTURE_ID = 'water-filter';
