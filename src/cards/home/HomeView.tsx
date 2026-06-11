/**
 * FAIRPLAY · HomeView
 * House blueprint with clickable room zones.
 * Tasks bind via meta.zone (room id). Zone filter drives side panel.
 *
 * Blueprint SVG is fully data-driven from floorplan.ts — edit that
 * file to match the user's actual house layout.
 */
import React, { useMemo, useState } from 'react';
import { isAfter, parseISO, startOfDay } from 'date-fns';
import type { CardDef, FpTask } from '../../lib/types';
import { useCardTasks, useCloseTask, useUpdateTask, useConnection } from '../../lib/todoist/hooks';
import { SideTaskRow, GroupLabel, LoadState } from '../../shell/atoms';
import { QuickAdd } from '../../shell/QuickAdd';
import { CharterPanel } from '../../shell/CharterPanel';
import { ROOMS, DOOR_ARCS, type Room } from './floorplan';
import './home.css';

interface Props {
  card: CardDef;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert polar degrees to SVG arc endpoint (x,y). */
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
  // Hinge line from center to arc start, then arc
  return `M ${cx} ${cy} L ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
}

/** Is a task overdue (due date strictly before today)? */
function isOverdue(task: FpTask): boolean {
  if (!task.due) return false;
  return isAfter(startOfDay(new Date()), parseISO(task.due.date));
}

// ─── Blueprint SVG component ─────────────────────────────────────────────────

interface BlueprintProps {
  rooms: Room[];
  tasksByZone: Map<string, FpTask[]>;
  overdueByZone: Set<string>;
  activeZone: string | null;
  onZoneClick: (id: string) => void;
}

function BlueprintSVG({
  rooms,
  tasksByZone,
  overdueByZone,
  activeZone,
  onZoneClick,
}: BlueprintProps) {
  // Grid spacing for the blueprint background (56-unit intervals in a 560×330 box)
  const gridCols = Array.from({ length: 11 }, (_, i) => i * 56);
  const gridRows = Array.from({ length: 7 }, (_, i) => i * (330 / 6));

  return (
    <svg className="blueprint" viewBox="0 0 560 330" aria-label="House blueprint">
      {/* ── Blueprint background grid ──────────────────────────────────── */}
      {gridCols.map((x) => (
        <line key={`gc${x}`} className="bp-grid" x1={x} y1={0} x2={x} y2={330} />
      ))}
      {gridRows.map((y) => (
        <line key={`gr${y}`} className="bp-grid" x1={0} y1={y} x2={560} y2={y} />
      ))}

      {/* ── Room fills + labels (interactive) ─────────────────────────── */}
      {rooms.map((room) => {
        const tasks = tasksByZone.get(room.id) ?? [];
        const hasOverdue = overdueByZone.has(room.id);
        const isActive = activeZone === room.id;
        const midX = room.x + room.w / 2;
        const midY = room.y + room.h / 2;

        return (
          <g
            key={room.id}
            className={`bp-room${isActive ? ' active' : ''}${room.exterior ? ' exterior' : ''}`}
            onClick={(e) => { e.stopPropagation(); onZoneClick(room.id); }}
            role="button"
            aria-pressed={isActive}
            aria-label={room.label}
          >
            {/* Clickable fill rect */}
            <rect
              className="room-fill"
              x={room.x}
              y={room.y}
              width={room.w}
              height={room.h}
            />

            {/* Room label — skip for very thin exterior bands */}
            {!room.exterior && (
              <text
                className="room-lbl"
                x={midX}
                y={midY - (tasks.length > 0 ? 7 : 0)}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {room.label}
              </text>
            )}

            {/* Task pip + count badge */}
            {tasks.length > 0 && !room.exterior && (
              <g className={`room-pip${hasOverdue ? ' overdue' : ''}`}>
                <circle className="pip-dot" cx={midX} cy={midY + 8} r={8} />
                <text className="pip-count" x={midX} y={midY + 8}>
                  {tasks.length > 9 ? '9+' : String(tasks.length)}
                </text>
              </g>
            )}

            {/* Exterior band label (smaller) */}
            {room.exterior && (
              <text
                className="room-lbl"
                x={midX}
                y={room.y + room.h / 2}
                textAnchor="middle"
                dominantBaseline="central"
                style={{ fontSize: 6.5 }}
              >
                {room.label}
              </text>
            )}
          </g>
        );
      })}

      {/* ── Outer double-line walls ────────────────────────────────────── */}
      {/* Outer face */}
      <rect className="wall-outer" x={2} y={2} width={556} height={326} />
      {/* Inner face (inset by wall thickness ~5 units) */}
      <rect className="wall-inner" x={22} y={22} width={516} height={286} />

      {/* ── Interior partition walls ───────────────────────────────────── */}
      {/* Horizontal partitions */}
      <line className="wall-int" x1={22}  y1={138} x2={538} y2={138} />
      <line className="wall-int" x1={22}  y1={238} x2={538} y2={238} />
      {/* Vertical partitions — main floor */}
      <line className="wall-int" x1={176} y1={22}  x2={176} y2={138} />
      <line className="wall-int" x1={304} y1={22}  x2={304} y2={138} />
      {/* Vertical partitions — lower floor */}
      <line className="wall-int" x1={176} y1={138} x2={176} y2={238} />
      <line className="wall-int" x1={304} y1={138} x2={304} y2={238} />
      <line className="wall-int" x1={384} y1={138} x2={384} y2={238} />
      <line className="wall-int" x1={456} y1={138} x2={456} y2={238} />

      {/* ── Door swing arcs ───────────────────────────────────────────── */}
      {DOOR_ARCS.map((arc, i) => (
        <path
          key={`door${i}`}
          className="door-arc"
          d={doorArcPath(arc.cx, arc.cy, arc.r, arc.startAngle, arc.endAngle)}
        />
      ))}

      {/* ── Dimension tick marks ──────────────────────────────────────── */}
      {/* Bottom dimension line spanning outer wall */}
      <line className="dim-ln" x1={2}   y1={330} x2={558} y2={330} />
      <line className="dim-ln" x1={2}   y1={326} x2={2}   y2={330} />
      <line className="dim-ln" x1={558} y1={326} x2={558} y2={330} />
      <text className="dim-txt" x={280} y={329} textAnchor="middle">OVERALL WIDTH</text>
      {/* Right dimension line spanning outer wall height */}
      <line className="dim-ln" x1={558} y1={2}   x2={558} y2={308} />
      <line className="dim-ln" x1={554} y1={2}   x2={558} y2={2}   />
      <line className="dim-ln" x1={554} y1={308} x2={558} y2={308} />
      <text
        className="dim-txt"
        x={559}
        y={155}
        textAnchor="middle"
        transform="rotate(90 559 155)"
      >
        OVERALL DEPTH
      </text>

      {/* ── Title block (bottom-left corner) ─────────────────────────── */}
      <rect className="title-block" x={2} y={308} width={196} height={20} />
      <line className="dim-ln" x1={2}   y1={312} x2={198} y2={312} />
      <line className="dim-ln" x1={66}  y1={308} x2={66}  y2={328} />
      <line className="dim-ln" x1={132} y1={308} x2={132} y2={328} />

      <text className="title-txt" x={34}  y={319} textAnchor="middle" style={{ fontSize: 7 }}>
        RESIDENCE
      </text>
      <text className="title-txt" x={99}  y={319} textAnchor="middle" style={{ fontSize: 7 }}>
        PLAN
      </text>
      <text className="title-txt" x={165} y={319} textAnchor="middle" style={{ fontSize: 7 }}>
        REV 02
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

  // Map room id → tasks with that zone; also track overdue rooms
  const { tasksByZone, overdueByZone, unzonedTasks } = useMemo(() => {
    const byZone = new Map<string, FpTask[]>();
    const overdue = new Set<string>();
    const unzoned: FpTask[] = [];

    for (const t of tasks ?? []) {
      const z = t.meta?.zone;
      if (z && typeof z === 'string') {
        const arr = byZone.get(z) ?? [];
        arr.push(t);
        byZone.set(z, arr);
        if (isOverdue(t)) overdue.add(z);
      } else {
        unzoned.push(t);
      }
    }
    return { tasksByZone: byZone, overdueByZone: overdue, unzonedTasks: unzoned };
  }, [tasks]);

  // Side panel: filtered or all tasks
  const sideTasks = useMemo<FpTask[]>(() => {
    if (!tasks) return [];
    if (!activeZone) return tasks;
    return tasks.filter((t) => t.meta?.zone === activeZone);
  }, [tasks, activeZone]);

  // Aggregate stats
  const openCount = tasks?.length ?? 0;
  const overdueCount = useMemo(() => (tasks ?? []).filter(isOverdue).length, [tasks]);
  const zonesWithTasks = tasksByZone.size;

  // Active room label
  const activeRoom = ROOMS.find((r) => r.id === activeZone);

  function handleZoneClick(id: string) {
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

  // ── Render states ────────────────────────────────────────────────────────

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

  // ── Full render ──────────────────────────────────────────────────────────

  return (
    <div className="view">
      {/* ── View head ─────────────────────────────────────────────────── */}
      <div className="view-head">
        <ViewHeadInner
          card={card}
          openCount={openCount}
          zonesWithTasks={zonesWithTasks}
          overdueCount={overdueCount}
        />
      </div>

      <CharterPanel card={card} />

      {/* ── Bespoke body ──────────────────────────────────────────────── */}
      <div className="bespoke">

        {/* Stage: blueprint */}
        <div className="stage">
          <div className="tick-c tl" /><div className="tick-c tr" />
          <div className="tick-c bl" /><div className="tick-c br" />

          <div className="stage-head">
            <span className="lbl">
              BLUEPRINT · FLOOR PLAN · CLICK ROOM TO FILTER ▸
            </span>
            <span className="lbl">
              {activeZone
                ? `ZONE: ${(activeRoom?.label ?? activeZone).toUpperCase()} ▸`
                : 'ALL ZONES'}
            </span>
          </div>

          <div className="blueprint-wrap" onClick={() => setActiveZone(null)}>
            <BlueprintSVG
              rooms={ROOMS}
              tasksByZone={tasksByZone}
              overdueByZone={overdueByZone}
              activeZone={activeZone}
              onZoneClick={handleZoneClick}
            />
          </div>

          <div className="stage-foot sheet-label">
            <span>SHEET A-1 · SCALE NTS</span>
            <span>CLICK ROOM TO FILTER · CLICK STAGE TO CLEAR</span>
            <span>REV 02</span>
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

// Zone assign select (shown in SideTaskRow right slot)
interface ZoneSelectProps {
  value: string;
  onChange: (zone: string) => void;
}

function ZoneSelect({ value, onChange }: ZoneSelectProps) {
  return (
    <select
      className="zone-sel"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      title="Assign to room"
    >
      <option value="">— ZONE</option>
      {ROOMS.filter((r) => !r.exterior).map((r) => (
        <option key={r.id} value={r.id}>
          {r.label}
        </option>
      ))}
      {ROOMS.filter((r) => r.exterior).map((r) => (
        <option key={r.id} value={r.id}>
          {r.label}
        </option>
      ))}
    </select>
  );
}
