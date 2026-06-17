/**
 * FAIRPLAY · Mobile Done.
 * Recently completed work for the active owner (last 7 days), swipe-to-reopen.
 * Single group — FpTask carries no completion timestamp, so we don't sub-group
 * by JUST NOW / TODAY / THIS WEEK as the static prototype did.
 */
import React from 'react';
import { useDeck, useCompletedTasks, useReopenTask, useConnection } from '../lib/todoist/hooks';
import { useProfile } from '../state/settings';
import { PROFILES } from '../cards/deck-config';
import { MobileTaskRow } from './MobileTaskRow';
import { GroupDivider, NoTokenNotice } from './atoms';

export function MobileDone() {
  const profile = useProfile();
  const connection = useConnection();
  const { data: deck = [] } = useDeck();
  const { data: completed = [], isLoading, isError, refetch } = useCompletedTasks(7);
  const reopen = useReopenTask();

  const name = PROFILES[profile].name;

  let body: React.ReactNode;
  if (connection.status === 'no-token') {
    body = <NoTokenNotice />;
  } else if (isLoading || connection.status === 'checking') {
    body = <div className="m-empty">SYNCING…</div>;
  } else if (isError || connection.status === 'error') {
    body = (
      <div className="m-empty">
        <div className="big">LINK DOWN</div>
        Couldn’t load completed tasks.
        <button onClick={() => void refetch()}>Retry</button>
      </div>
    );
  } else if (completed.length === 0) {
    body = (
      <div className="m-empty">
        <div className="big">NOTHING YET</div>
        Completed tasks land here.
      </div>
    );
  } else {
    body = (
      <div>
        <GroupDivider label="DONE · LAST 7 DAYS" count={completed.length} />
        {completed.map((t) => (
          <MobileTaskRow
            key={t.id}
            task={t}
            card={deck.find((c) => c.id === t.cardId)}
            showTag
            done
            onToggle={() => reopen.mutate(t.id)}
          />
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="m-head">
        <div className="m-kicker mono up">
          <span className="tick" />
          COMPLETED
        </div>
        <div className="m-h1">Done</div>
        <div className="m-h1-sub">
          {completed.length} closed by {name} recently
        </div>
      </div>
      <div className="m-pad m-pad-b" style={{ paddingTop: 0 }}>
        {body}
      </div>
    </>
  );
}
