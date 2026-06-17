/**
 * FAIRPLAY · Mobile shared atoms.
 * OwnerToggle (Amy ⇆ Kyle) and GroupDivider. Both reuse the desktop data layer.
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useProfile, useSettings } from '../state/settings';
import { PROFILE_ORDER, PROFILES } from '../cards/deck-config';
import { useDeckTasks } from '../lib/todoist/hooks';

/**
 * Amy / Kyle owner toggle. Switching = setProfile, which re-points every
 * profile-scoped query at the other deck. The count shown is the ACTIVE
 * owner's open-task count (from the profile-scoped cache); the inactive owner
 * shows a placeholder dot, since fetching the other deck just for a badge isn't
 * worth the round-trip.
 */
export function OwnerToggle() {
  const profile = useProfile();
  const setProfile = useSettings((s) => s.setProfile);
  const { data: tasks = [] } = useDeckTasks();
  const activeCount = tasks.length;

  return (
    <div className="m-ownerbar">
      <div className="m-owner">
        {PROFILE_ORDER.map((id) => {
          const p = PROFILES[id];
          const on = profile === id;
          return (
            <button
              key={id}
              className={on ? 'on' : ''}
              onClick={() => setProfile(id)}
              aria-pressed={on}
            >
              <span className="av">{p.name.charAt(0).toUpperCase()}</span>
              <span>{p.name}</span>
              <span className="ct">{on ? activeCount : '·'}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface GroupDividerProps {
  label: string;
  count?: number;
  urgent?: boolean;
}

export function GroupDivider({ label, count, urgent }: GroupDividerProps) {
  return (
    <div className={`m-grp mono up${urgent ? ' urgent' : ''}`}>
      <span>{urgent ? '◆ ' + label : label}</span>
      <span className="ln" />
      {count !== undefined && <span className="ct">{String(count).padStart(2, '0')}</span>}
    </div>
  );
}

/**
 * Shown in any task screen's body when there's no Todoist token, so a tokenless
 * phone doesn't read as "ALL CLEAR". Links to the Me screen to add one.
 */
export function NoTokenNotice() {
  const navigate = useNavigate();
  return (
    <div className="m-empty">
      <div className="big">NO TODOIST TOKEN</div>
      Add your API token in Me to load your deck.
      <button onClick={() => navigate('/settings')}>Go to Me</button>
    </div>
  );
}
