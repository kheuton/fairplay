/**
 * FAIRPLAY · Mobile Card detail.
 * Every card kind renders as the same time-grouped task list — the bespoke
 * desktop art (Auto schematic, Home blueprint, Inventory grid, Date Night
 * calendar) is intentionally NOT mounted on phones.
 */
import React from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { useDeck, useCardTasks, useCloseTask, useConnection } from '../lib/todoist/hooks';
import { useProfile } from '../state/settings';
import { PROFILES } from '../cards/deck-config';
import { TRIAGE_ORDER } from '../lib/triage';
import { MobileTaskGroups } from './TaskGroups';
import { NoTokenNotice } from './atoms';
import { Ic } from './icons';

export function MobileCardDetail() {
  const { id } = useParams<{ id: string }>();
  const now = new Date();
  const navigate = useNavigate();
  const profile = useProfile();
  const connection = useConnection();
  const { data: deck = [], isLoading: deckLoading } = useDeck();
  const { data: tasks = [], isLoading, isError, refetch } = useCardTasks(id ?? '');
  const closeTask = useCloseTask();

  const card = deck.find((c) => c.id === id);

  // Deck resolved but this id isn't in it → bounce home (mirrors desktop CardPage).
  if (!deckLoading && deck.length > 0 && !card) {
    return <Navigate to="/" replace />;
  }

  const name = PROFILES[profile].name;
  const openCount = tasks.length;

  let body: React.ReactNode;
  if (connection.status === 'no-token') {
    body = <NoTokenNotice />;
  } else if (isLoading || connection.status === 'checking') {
    body = <div className="m-empty">SYNCING…</div>;
  } else if (isError || connection.status === 'error') {
    body = (
      <div className="m-empty">
        <div className="big">LINK DOWN</div>
        Couldn’t load this card.
        <button onClick={() => void refetch()}>Retry</button>
      </div>
    );
  } else {
    body = (
      <MobileTaskGroups
        tasks={tasks}
        buckets={TRIAGE_ORDER}
        now={now}
        onComplete={(tid) => closeTask.mutate(tid)}
        emptyLabel="ALL CLEAR"
        emptySub="No open tasks on this card."
      />
    );
  }

  return (
    <>
      <div className="m-head">
        <button className="m-back" onClick={() => navigate('/')}>
          {Ic.chevL({ s: 11, c: 'currentColor' })} CARDS
        </button>
        <div className="m-kicker mono up">
          <span className="tick" />
          CARD · {card?.category ?? ''}
        </div>
        <div className="m-h1">{card?.name ?? '…'}</div>
        <div className="m-h1-sub">
          {openCount} open for {name}
        </div>
      </div>
      <div className="m-pad m-pad-b" style={{ paddingTop: 0 }}>
        {body}
      </div>
    </>
  );
}
