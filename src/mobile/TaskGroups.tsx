/**
 * FAIRPLAY · MobileTaskGroups
 * Renders FpTasks grouped into the shared triage buckets, each row swipe-to-
 * complete. Used by the Inbox (OVERDUE/TODAY/THIS WEEK, tags shown) and Card
 * detail (all four buckets, tags hidden).
 */
import React from 'react';
import type { FpTask, CardDef } from '../lib/types';
import { groupByTriage, type TriageGroup } from '../lib/triage';
import { MobileTaskRow } from './MobileTaskRow';
import { GroupDivider } from './atoms';

interface TaskGroupsProps {
  tasks: FpTask[];
  /** Which buckets to render, in order. */
  buckets: TriageGroup[];
  /** Deck for card-tag lookup (only needed when showTag). */
  deck?: CardDef[];
  showTag?: boolean;
  now: Date;
  onComplete: (taskId: string) => void;
  emptyLabel?: string;
  emptySub?: string;
}

export function MobileTaskGroups({
  tasks,
  buckets,
  deck,
  showTag = false,
  now,
  onComplete,
  emptyLabel = 'ALL CLEAR',
  emptySub = 'Nothing on this list.',
}: TaskGroupsProps) {
  const grouped = groupByTriage(tasks, now);
  const visible = buckets.filter((b) => grouped[b].length > 0);

  if (visible.length === 0) {
    return (
      <div className="m-empty">
        <div className="big">{emptyLabel}</div>
        {emptySub}
      </div>
    );
  }

  return (
    <>
      {visible.map((b) => (
        <div key={b}>
          <GroupDivider label={b} count={grouped[b].length} urgent={b === 'OVERDUE'} />
          {grouped[b].map((t) => (
            <MobileTaskRow
              key={t.id}
              task={t}
              card={showTag ? deck?.find((c) => c.id === t.cardId) : undefined}
              showTag={showTag}
              onToggle={() => onComplete(t.id)}
            />
          ))}
        </div>
      ))}
    </>
  );
}
