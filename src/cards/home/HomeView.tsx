/**
 * FAIRPLAY · HomeView
 * Apartment blueprint with clickable room zones — data-driven from floorplan.ts.
 * Two-level toggle (main / basement). Water-filter fixture has a live health ring.
 * Tasks bind via meta.zone (room id). Zone filter drives the side panel.
 * When filterOpen is true the side panel shows the WaterFilter component instead.
 */
import React, { useMemo, useState } from 'react';
import { isAfter, parseISO, startOfDay } from 'date-fns';
import type { CardDef, FpTask } from '../../lib/types';
import {
  useCardTasks,
  useCloseTask,
  useUpdateTask,
  useConnection,
  useWaterFilter,
} from '../../lib/todoist/hooks';
import { SideTaskRow, GroupLabel, LoadState } from '../../shell/atoms';
import { QuickAdd } from '../../shell/QuickAdd';
import { CharterPanel } from '../../shell/CharterPanel';
import { WaterFilter } from './WaterFilter';
import {
  VIEWBOX,
  OUTER_WALL,
  ALL_ROOMS,
  WATER_FILTER_FIXTURE_ID,
  getLevel,
  type LevelId,
  type Room,
  type Fixture,
  type Bay,
  type DoorArc,
} from './floorplan';
import './home.css';

interface Props {
  card: CardDef;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert polar degrees to SVG arc endpoint (0=right, 90=down convention). */
function polarToXY(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg - 90) * (Math.PI / 180);
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

/** Build SVG arc path for a door swing. */
function doorArcPath(
  cx: number, cy: number, r: number,
  startDeg: number, endDeg: number
): string {
  const s = polarToXY(cx, cy, r, startDeg);
  const e = polarToXY(cx, cy, r, endDeg);
  const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

/** Is a task overdue (due date strictly before today)? */
function isOverdue(task: FpTask): boolean {
  if (!task.due) return false;
  return isAfter(startOfDay(new Date()), parseISO(task.due.date));
}

// ─── Bay-window flourish ──────────────────────────────────────────────────────

function BayWindow({ bay }: { bay: Bay }) {
  const { x0, x1, y, depth, panes = 3 } = bay;
  const inset = 6;
  const pts = [
    `${x0},${y}`,
    `${x0 + inset},${y - depth}`,
    `${x1 - inset},${y - depth}`,
    `${x1},${y}`,
  ].join(' ');

  // Mullion lines — evenly spaced between x0+inset and x1-inset
  const mullionX: number[] = [];
  const innerW = x1 - inset - (x0 + inset);
  for (let i = 1; i < panes; i++) {
    mullionX.push(x0 + inset + (innerW * i) / panes);
  }

  return (
    <g className="bp-bay">
      <polygon points={pts} />
      {mullionX.map((mx, i) => (
        <line
          key={i}
          x1={mx}
          y1={y - depth}
          x2={mx + (mx - (x0 + inset)) * 0.1}
          y2={y}
        />
      ))}
    </g>
  );
}

// ─── Blueprint SVG component ─────────────────────────────────────────────────

interface BlueprintProps {
  rooms: Room[];
  fixtures: Fixture[];
  doors: DoorArc[];
  tasksByZone: Map<string, FpTask[]>;
  overdueByZone: Set<string>;
  activeZone: string | null;
  onZoneClick: (id: string) => void;
  filterStatus: 'ok' | 'low' | 'out';
  filterLifeFrac: number;
  onFilterClick: () => void;
}

function BlueprintSVG({
  rooms,
  fixtures,
  doors,
  tasksByZone,
  overdueByZone,
  activeZone,
  onZoneClick,
  filterStatus: fStatus,
  filterLifeFrac: fLifeFrac,
  onFilterClick,
}: BlueprintProps) {
  const { w, h } = VIEWBOX;

  // Grid lines — ~14 cols × ~24 rows at ~36-unit spacing
  const gridStep = 36;
  const gridCols: number[] = [];
  const gridRows: number[] = [];
  for (let x = 0; x <= w; x += gridStep) gridCols.push(x);
  for (let y = 0; y <= h; y += gridStep) gridRows.push(y);

  // Filter arc math — a circular ring drawn as an SVG arc
  const filterRingR = 10;
  const filterRingCx = (fx: Fixture) =>
    fx.shape.kind === 'rect' ? fx.shape.x + fx.shape.w / 2 : 0;
  const filterRingCy = (fx: Fixture) =>
    fx.shape.kind === 'rect' ? fx.shape.y + fx.shape.h / 2 : 0;

  function filterArcPath(cx: number, cy: number, r: number, frac: number): string {
    if (frac <= 0) return '';
    if (frac >= 1) {
      // Full circle: two half-arcs
      return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r}`;
    }
    const angle = frac * 360 - 90; // start at top (−90°)
    const rad = (angle * Math.PI) / 180;
    const ex = cx + r * Math.cos(rad);
    const ey = cy + r * Math.sin(rad);
    const large = frac > 0.5 ? 1 : 0;
    return `M ${cx} ${cy - r} A ${r} ${r} 0 ${large} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
  }

  const filterArcColor =
    fStatus === 'out'
      ? 'var(--accent)'
      : fStatus === 'low'
      ? '#E0A23A'
      : 'var(--accent-2)';

  return (
    <svg
      className="blueprint"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid meet"
      aria-label="Apartment floor plan"
    >
      {/* ── Blueprint grid ─────────────────────────────────────────── */}
      {gridCols.map((x) => (
        <line key={`gc${x}`} className="bp-grid" x1={x} y1={0} x2={x} y2={h} />
      ))}
      {gridRows.map((y) => (
        <line key={`gr${y}`} className="bp-grid" x1={0} y1={y} x2={w} y2={y} />
      ))}

      {/* ── Rooms ──────────────────────────────────────────────────── */}
      {rooms.map((room) => {
        const tasks = tasksByZone.get(room.id) ?? [];
        const hasOverdue = overdueByZone.has(room.id);
        const isActive = activeZone === room.id;
        const midX = room.x + room.w / 2;
        const midY = room.y + room.h / 2;
        const labelX = room.labelX ?? midX;
        const labelY = room.labelY ?? midY;
        const polyPts =
          room.poly && room.poly.length >= 3
            ? room.poly.map(([px, py]) => `${px},${py}`).join(' ')
            : null;
        const isVoid = room.void === true;
        const isExt = room.exterior === true;

        const roomClasses = [
          'bp-room',
          isActive ? 'active' : '',
          isVoid ? 'void' : '',
          isExt ? 'exterior' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <g
            key={room.id}
            className={roomClasses}
            onClick={
              isVoid
                ? undefined
                : (e) => {
                    e.stopPropagation();
                    onZoneClick(room.id);
                  }
            }
            role={isVoid ? undefined : 'button'}
            aria-pressed={isVoid ? undefined : isActive}
            aria-label={isVoid ? undefined : room.label}
            style={{ cursor: isVoid ? 'default' : 'pointer' }}
          >
            {/* Floor fill (transparent — used for hit-testing) */}
            {polyPts ? (
              <polygon className="room-fill" points={polyPts} />
            ) : (
              <rect className="room-fill" x={room.x} y={room.y} width={room.w} height={room.h} />
            )}
            {/* Room border (interior partitions come for free from the stroke) */}
            {polyPts ? (
              <polygon className="room-border" points={polyPts} />
            ) : (
              <rect className="room-border" x={room.x} y={room.y} width={room.w} height={room.h} />
            )}

            {/* Bay windows (legacy flourish — front rooms now use the angled wall) */}
            {room.bays?.map((bay, bi) => (
              <BayWindow key={bi} bay={bay} />
            ))}

            {/* Room label */}
            <text
              className="room-lbl"
              x={labelX}
              y={labelY - (tasks.length > 0 && !isVoid ? 9 : 0)}
              textAnchor="middle"
              dominantBaseline="central"
              style={isExt ? { fontSize: '6.5px' } : undefined}
            >
              {room.label}
            </text>

            {/* Task pip — not for void rooms */}
            {tasks.length > 0 && !isVoid && (
              <g className={`room-pip${hasOverdue ? ' overdue' : ''}`}>
                <circle className="pip-dot" cx={labelX} cy={labelY + 10} r={8} />
                <text className="pip-count" x={labelX} y={labelY + 10}>
                  {tasks.length > 9 ? '9+' : String(tasks.length)}
                </text>
              </g>
            )}
          </g>
        );
      })}

      {/* ── Outer double-line wall (angled north facade) ─────────────── */}
      <polygon
        className="wall-outer"
        points={OUTER_WALL.outerPoly.map(([x, y]) => `${x},${y}`).join(' ')}
      />
      <polygon
        className="wall-inner"
        points={OUTER_WALL.innerPoly.map(([x, y]) => `${x},${y}`).join(' ')}
      />

      {/* ── Fixtures ───────────────────────────────────────────────── */}
      {fixtures.map((fx) => {
        const isFilter = fx.id === WATER_FILTER_FIXTURE_ID;
        const varClass = `fx-${fx.variant}`;

        if (fx.shape.kind === 'rect') {
          const { x, y, w: fw, h: fh } = fx.shape;
          const cx = x + fw / 2;
          const cy = y + fh / 2;

          // Bed: pillow line near the top edge
          const pillowLine =
            fx.variant === 'bed' ? (
              <line
                className="fx-pillow"
                x1={x + 3}
                y1={y + 8}
                x2={x + fw - 3}
                y2={y + 8}
              />
            ) : null;

          // Filter: health ring + clickable
          if (isFilter) {
            const ringCx = filterRingCx(fx);
            const ringCy = filterRingCy(fx);
            const arcD = filterArcPath(ringCx, ringCy, filterRingR, fLifeFrac);
            return (
              <g
                key={fx.id}
                className={`fx ${varClass}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onFilterClick();
                }}
                role="button"
                aria-label="Water filter — view health"
                style={{ cursor: 'pointer' }}
              >
                <rect x={x} y={y} width={fw} height={fh} />
                {/* Health ring */}
                <circle
                  className="fx-filter-track"
                  cx={ringCx}
                  cy={ringCy}
                  r={filterRingR}
                />
                {arcD && (
                  <path
                    className="fx-filter-arc"
                    d={arcD}
                    stroke={filterArcColor}
                    fill="none"
                  />
                )}
                {fx.label && (
                  <text className="fx-lbl" x={cx} y={cy + filterRingR + 5}>
                    {fx.label}
                  </text>
                )}
              </g>
            );
          }

          return (
            <g key={fx.id} className={`fx ${varClass}`}>
              <rect x={x} y={y} width={fw} height={fh} />
              {pillowLine}
              {fx.label && (
                <text className="fx-lbl" x={cx} y={cy}>
                  {fx.label}
                </text>
              )}
              {fx.items?.slice(0, 2).map((item, ii) => (
                <text
                  key={ii}
                  className="fx-item"
                  x={cx}
                  y={cy + (ii - (Math.min(fx.items!.length, 2) - 1) / 2) * 8}
                >
                  {item}
                </text>
              ))}
            </g>
          );
        }

        // poly shape
        if (fx.shape.kind === 'poly') {
          const pts = fx.shape.points.map(([px, py]) => `${px},${py}`).join(' ');
          const xs = fx.shape.points.map(([px]) => px);
          const ys = fx.shape.points.map(([, py]) => py);
          const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
          const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
          const isPlay = fx.variant === 'play';
          // For play-variant, anchor label at the top edge rather than centroid
          // so it doesn't collide with any contained fixture labels
          const labelY = isPlay ? Math.min(...ys) - 3 : cy;
          return (
            <g key={fx.id} className={`fx ${varClass}${isPlay ? ' fx-play-outline' : ''}`}>
              <polygon points={pts} />
              {fx.label && (
                <text className="fx-lbl" x={cx} y={labelY}>
                  {fx.label}
                </text>
              )}
            </g>
          );
        }

        return null;
      })}

      {/* ── Door arcs ──────────────────────────────────────────────── */}
      {doors.map((arc, i) => (
        <path
          key={`door${i}`}
          className="door-arc"
          d={doorArcPath(arc.cx, arc.cy, arc.r, arc.startAngle, arc.endAngle)}
        />
      ))}

      {/* ── Dimension annotations ──────────────────────────────────── */}
      {/* Bottom dimension line */}
      <line className="dim-ln" x1={OUTER_WALL.outer.x} y1={h - 6} x2={OUTER_WALL.outer.x + OUTER_WALL.outer.w} y2={h - 6} />
      <line className="dim-ln" x1={OUTER_WALL.outer.x} y1={h - 10} x2={OUTER_WALL.outer.x} y2={h - 4} />
      <line className="dim-ln" x1={OUTER_WALL.outer.x + OUTER_WALL.outer.w} y1={h - 10} x2={OUTER_WALL.outer.x + OUTER_WALL.outer.w} y2={h - 4} />
      <text className="dim-txt" x={w / 2} y={h - 2} textAnchor="middle">OVERALL WIDTH</text>

      {/* Right dimension line */}
      <line className="dim-ln" x1={w - 6} y1={OUTER_WALL.outer.y} x2={w - 6} y2={OUTER_WALL.outer.y + OUTER_WALL.outer.h} />
      <line className="dim-ln" x1={w - 10} y1={OUTER_WALL.outer.y} x2={w - 4} y2={OUTER_WALL.outer.y} />
      <line className="dim-ln" x1={w - 10} y1={OUTER_WALL.outer.y + OUTER_WALL.outer.h} x2={w - 4} y2={OUTER_WALL.outer.y + OUTER_WALL.outer.h} />
      <text
        className="dim-txt"
        x={w - 2}
        y={h / 2}
        textAnchor="middle"
        transform={`rotate(90 ${w - 2} ${h / 2})`}
      >
        OVERALL DEPTH
      </text>

      {/* ── Title block ────────────────────────────────────────────── */}
      <rect className="title-block" x={OUTER_WALL.outer.x} y={h - 30} width={200} height={22} />
      <line className="dim-ln" x1={OUTER_WALL.outer.x} y1={h - 22} x2={OUTER_WALL.outer.x + 200} y2={h - 22} />
      <line className="dim-ln" x1={OUTER_WALL.outer.x + 66} y1={h - 30} x2={OUTER_WALL.outer.x + 66} y2={h - 8} />
      <line className="dim-ln" x1={OUTER_WALL.outer.x + 133} y1={h - 30} x2={OUTER_WALL.outer.x + 133} y2={h - 8} />

      <text className="title-txt" x={OUTER_WALL.outer.x + 33} y={h - 17} textAnchor="middle" style={{ fontSize: '7px' }}>
        RESIDENCE
      </text>
      <text className="title-txt" x={OUTER_WALL.outer.x + 99} y={h - 17} textAnchor="middle" style={{ fontSize: '7px' }}>
        PLAN
      </text>
      <text className="title-txt" x={OUTER_WALL.outer.x + 166} y={h - 17} textAnchor="middle" style={{ fontSize: '7px' }}>
        REV 03
      </text>
    </svg>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

export default function HomeView({ card }: Props) {
  const { status: connStatus } = useConnection();
  const { data: tasks, isLoading, isError, refetch } = useCardTasks(card.id);
  const closeTask = useCloseTask();
  const updateTask = useUpdateTask();
  const [activeZone, setActiveZone] = useState<string | null>(null);
  const [qaOpen, setQaOpen] = useState(false);
  const [level, setLevel] = useState<LevelId>('main');
  const [filterOpen, setFilterOpen] = useState(false);

  // Water filter hook (always called — conditional return comes after all hooks)
  const wf = useWaterFilter(card.id);

  // Map room id → tasks with that zone; also track overdue rooms
  const { tasksByZone, overdueByZone } = useMemo(() => {
    const byZone = new Map<string, FpTask[]>();
    const overdue = new Set<string>();

    for (const t of tasks ?? []) {
      const z = t.meta?.zone;
      if (z && typeof z === 'string') {
        const arr = byZone.get(z) ?? [];
        arr.push(t);
        byZone.set(z, arr);
        if (isOverdue(t)) overdue.add(z);
      }
    }
    return { tasksByZone: byZone, overdueByZone: overdue };
  }, [tasks]);

  // Side panel: tasks filtered by active zone or all
  const sideTasks = useMemo<FpTask[]>(() => {
    if (!tasks) return [];
    if (!activeZone) return tasks;
    return tasks.filter((t) => t.meta?.zone === activeZone);
  }, [tasks, activeZone]);

  // Aggregate stats
  const openCount = tasks?.length ?? 0;
  const overdueCount = useMemo(() => (tasks ?? []).filter(isOverdue).length, [tasks]);
  const zonesWithTasks = tasksByZone.size;

  // Active room label (search ALL_ROOMS since zone may be on either level)
  const activeRoom = ALL_ROOMS.find((r) => r.id === activeZone);

  function handleZoneClick(id: string) {
    setFilterOpen(false);
    setActiveZone((prev) => (prev === id ? null : id));
  }

  function handleToggle(taskId: string) {
    closeTask.mutate(taskId);
  }

  function handleZoneAssign(taskId: string, zone: string) {
    const task = tasks?.find((t) => t.id === taskId);
    if (!task) return;
    updateTask.mutate({
      id: taskId,
      patch: { meta: { ...task.meta, zone: zone || undefined } },
    });
  }

  // Currently rendered level data
  const currentLevel = getLevel(level);

  // ── Render states ─────────────────────────────────────────────────────────

  if (connStatus === 'no-token') {
    return (
      <div className="view">
        <div className="view-head">
          <ViewHeadInner card={card} openCount={0} zonesWithTasks={0} overdueCount={0} />
        </div>
        <CharterPanel card={card} />
        <LoadState status="no-token" />
        <QuickAdd open={qaOpen} onClose={() => setQaOpen(false)} presetCardId={card.id} />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="view">
        <div className="view-head">
          <ViewHeadInner card={card} openCount={0} zonesWithTasks={0} overdueCount={0} />
        </div>
        <CharterPanel card={card} />
        <LoadState status="loading" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="view">
        <div className="view-head">
          <ViewHeadInner card={card} openCount={0} zonesWithTasks={0} overdueCount={0} />
        </div>
        <CharterPanel card={card} />
        <LoadState status="error" message="Could not load tasks" retry={() => void refetch()} />
      </div>
    );
  }

  // ── Full render ───────────────────────────────────────────────────────────

  return (
    <div className="view">
      {/* ── View head ───────────────────────────────────────────────── */}
      <div className="view-head">
        <ViewHeadInner
          card={card}
          openCount={openCount}
          zonesWithTasks={zonesWithTasks}
          overdueCount={overdueCount}
        />
      </div>

      <CharterPanel card={card} />

      {/* ── Bespoke body ────────────────────────────────────────────── */}
      {/* When the filter panel is open it takes over the ENTIRE bespoke area:
          WaterFilter is a two-pane layout (schematic + readouts) that needs the
          full width, not the narrow side slot. */}
      <div className="bespoke">
        {filterOpen ? (
          <WaterFilter card={card} onClose={() => setFilterOpen(false)} />
        ) : (
          <>

        {/* Stage: blueprint */}
        <div className="stage">
          <div className="tick-c tl" /><div className="tick-c tr" />
          <div className="tick-c bl" /><div className="tick-c br" />

          <div className="stage-head">
            <span className="lbl">
              BLUEPRINT · {currentLevel.label} · CLICK ROOM TO FILTER ▸
            </span>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {/* Filter health chip — shown when not 'ok' */}
              {wf.status !== 'ok' && (
                <button
                  className="filter-health-chip"
                  onClick={() => setFilterOpen(true)}
                >
                  FILTER · {wf.chip}
                </button>
              )}

              {/* Level toggle */}
              <div className="level-toggle">
                <button
                  className={level === 'main' ? 'active' : ''}
                  onClick={() => setLevel('main')}
                >
                  MAIN
                </button>
                <button
                  className={level === 'basement' ? 'active' : ''}
                  onClick={() => setLevel('basement')}
                >
                  BSMT
                </button>
              </div>

              <span className="lbl">
                {activeZone
                  ? `ZONE: ${(activeRoom?.label ?? activeZone).toUpperCase()} ▸`
                  : 'ALL ZONES'}
              </span>
            </div>
          </div>

          <div className="blueprint-wrap" onClick={() => setActiveZone(null)}>
            <BlueprintSVG
              rooms={currentLevel.rooms}
              fixtures={currentLevel.fixtures}
              doors={currentLevel.doors}
              tasksByZone={tasksByZone}
              overdueByZone={overdueByZone}
              activeZone={activeZone}
              onZoneClick={handleZoneClick}
              filterStatus={wf.status}
              filterLifeFrac={wf.lifeFrac}
              onFilterClick={() => setFilterOpen(true)}
            />
          </div>

          <div className="stage-foot sheet-label">
            <span>SHEET A-1 · SCALE NTS</span>
            <span>CLICK ROOM TO FILTER · CLICK STAGE TO CLEAR</span>
            <span>REV 03</span>
          </div>
        </div>

        {/* Side panel: task list */}
        <div className="bespoke-side">
              <div className="bs-head">
                <div className="peek-label mono up" style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>
                    {activeZone
                      ? `${(activeRoom?.label ?? activeZone).toUpperCase()} TASKS`
                      : 'ALL TASKS'}
                  </span>
                  <span>{sideTasks.length}</span>
                </div>

                {/* Zone filter chip */}
                {activeZone && (
                  <div
                    className="filter-chip"
                    onClick={() => setActiveZone(null)}
                    role="button"
                    aria-label="Clear zone filter"
                  >
                    ZONE · {(activeRoom?.label ?? activeZone).toUpperCase()}
                    <span className="x">✕</span>
                  </div>
                )}

                {/* + Task button */}
                <div style={{ marginTop: 14, display: 'flex', gap: 10, alignItems: 'center' }}>
                  <button
                    className="btn ghost"
                    style={{ fontSize: 10, padding: '5px 10px' }}
                    onClick={() => setQaOpen(true)}
                  >
                    + TASK
                  </button>
                </div>
              </div>

              <div className="bs-list">
                {sideTasks.length === 0 ? (
                  <LoadState
                    status="empty"
                    message={activeZone ? 'No tasks in this zone' : 'No open tasks'}
                  />
                ) : (
                  <div className="tlist">
                    {/* Overdue group */}
                    {sideTasks.some(isOverdue) && (
                      <>
                        <GroupLabel label="OVERDUE" count={sideTasks.filter(isOverdue).length} urgent />
                        {sideTasks.filter(isOverdue).map((t) => (
                          <SideTaskRow
                            key={t.id}
                            task={t}
                            onToggle={() => handleToggle(t.id)}
                            right={
                              <ZoneSelect
                                value={typeof t.meta?.zone === 'string' ? t.meta.zone : ''}
                                onChange={(z) => handleZoneAssign(t.id, z)}
                              />
                            }
                          />
                        ))}
                      </>
                    )}

                    {/* Upcoming group */}
                    {sideTasks.some((t) => !isOverdue(t)) && (
                      <>
                        <GroupLabel label="UPCOMING" count={sideTasks.filter((t) => !isOverdue(t)).length} />
                        {sideTasks.filter((t) => !isOverdue(t)).map((t) => (
                          <SideTaskRow
                            key={t.id}
                            task={t}
                            onToggle={() => handleToggle(t.id)}
                            right={
                              <ZoneSelect
                                value={typeof t.meta?.zone === 'string' ? t.meta.zone : ''}
                                onChange={(z) => handleZoneAssign(t.id, z)}
                              />
                            }
                          />
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
        </div>
          </>
        )}
      </div>

      {/* QuickAdd modal */}
      <QuickAdd open={qaOpen} onClose={() => setQaOpen(false)} presetCardId={card.id} />
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ViewHeadInnerProps {
  card: CardDef;
  openCount: number;
  zonesWithTasks: number;
  overdueCount: number;
}

function ViewHeadInner({ card, openCount, zonesWithTasks, overdueCount }: ViewHeadInnerProps) {
  return (
    <>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <div className="home-glyph">{card.num}</div>
        <div>
          <div className="kicker mono up">
            <span className="tick" />
            CARD · {card.category} · CUSTOM VIEW ◆
          </div>
          <div className="view-title">{card.name}</div>
        </div>
      </div>
      <div className="head-meta">
        <div className={`big${overdueCount > 0 ? ' coral' : ''}`}>{openCount}</div>
        <div className="mono up home-head-sub">
          {zonesWithTasks} ZONES · {overdueCount} OVERDUE
        </div>
      </div>
    </>
  );
}

// ─── ZoneSelect ───────────────────────────────────────────────────────────────

interface ZoneSelectProps {
  value: string;
  onChange: (zone: string) => void;
}

function ZoneSelect({ value, onChange }: ZoneSelectProps) {
  // Group: non-exterior rooms first, then exterior
  const nonExt = ALL_ROOMS.filter((r) => !r.exterior);
  const ext = ALL_ROOMS.filter((r) => r.exterior);
  return (
    <select
      className="zone-sel"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      title="Assign to room"
    >
      <option value="">— ZONE</option>
      {nonExt.map((r) => (
        <option key={r.id} value={r.id}>
          {r.label}
        </option>
      ))}
      {ext.map((r) => (
        <option key={r.id} value={r.id}>
          {r.label}
        </option>
      ))}
    </select>
  );
}
