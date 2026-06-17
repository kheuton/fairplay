/**
 * FAIRPLAY · Mobile Inbox (triage landing).
 * The active owner's OVERDUE / TODAY / THIS WEEK tasks across all cards.
 * Shares useDeckTasks + triage with the desktop InboxPage.
 */
import React from 'react';
import { format } from 'date-fns';
import { useDeck, useDeckTasks, useCloseTask, useConnection } from '../lib/todoist/hooks';
import { useProfile } from '../state/settings';
import { PROFILES } from '../cards/deck-config';
import { getTriageGroup, type TriageGroup } from '../lib/triage';
import { MobileTaskGroups } from './TaskGroups';
import { NoTokenNotice } from './atoms';

const INBOX_BUCKETS: TriageGroup[] = ['OVERDUE', 'TODAY', 'THIS WEEK'];

export function MobileInbox() {
  const now = new Date();
  const profile = useProfile();
  const connection = useConnection();
  const { data: deck = [] } = useDeck();
  const { data: tasks = [], isLoading, isError, refetch } = useDeckTasks();
  const closeTask = useCloseTask();

  const name = PROFILES[profile].name;
  // Count only the buckets the inbox renders (LATER/undated tasks live on their
  // card, not here) so the header doesn't claim more than it shows.
  const attention = tasks.filter((t) => INBOX_BUCKETS.includes(getTriageGroup(t, now)));
  const overdue = attention.filter((t) => getTriageGroup(t, now) === 'OVERDUE').length;
  const dateStr = format(now, 'EEE MMM d').toUpperCase();

  let body: React.ReactNode;
  if (connection.status === 'no-token') {
    body = <NoTokenNotice />;
  } else if (isLoading || connection.status === 'checking') {
    body = <div className="m-empty">SYNCING…</div>;
  } else if (isError || connection.status === 'error') {
    body = (
      <div className="m-empty">
        <div className="big">LINK DOWN</div>
        Couldn’t load tasks from Todoist.
        <button onClick={() => void refetch()}>Retry</button>
      </div>
    );
  } else {
    body = (
      <MobileTaskGroups
        tasks={tasks}
        buckets={INBOX_BUCKETS}
        deck={deck}
        showTag
        now={now}
        onComplete={(id) => closeTask.mutate(id)}
        emptyLabel="ALL CLEAR"
        emptySub="Nothing needs attention right now."
      />
    );
  }

  return (
    <>
      <div className="m-head">
        <div className="m-kicker mono up">
          <span className="tick" />
          TRIAGE · {dateStr}
        </div>
        <div className="m-h1">Needs attention</div>
        <div className="m-h1-sub">
          {attention.length} need attention for {name}
          {overdue > 0 && (
            <>
              {' · '}
              <b>{overdue} overdue</b>
            </>
          )}
        </div>
      </div>
      <div className="m-pad m-pad-b" style={{ paddingTop: 0 }}>
        {body}
      </div>
    </>
  );
}
