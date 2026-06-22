/**
 * FAIRPLAY · Mobile "Me" / settings.
 * Reuses the shared zustand settings store. Viewing-as = setProfile; theme is
 * per-profile (setTheme); density + grid via set(). A CONNECTION section lets a
 * phone (separate localStorage) supply its own Todoist token — required for the
 * deployed site, where each device provides its own token.
 *
 * The prototype's Notifications toggles are omitted (no notification backend).
 */
import React, { useState } from 'react';
import { useProfile, useSettings } from '../state/settings';
import { PROFILE_ORDER, PROFILES } from '../cards/deck-config';
import type { Theme, Density } from '../state/settings';

const THEMES: [Theme, string][] = [
  ['bone', 'Bone'],
  ['eclipse', 'Eclipse'],
  ['vapor', 'Vapor'],
];
const DENSITIES: Density[] = ['compact', 'comfy'];

export function MobileSettings() {
  const profile = useProfile();
  const setProfile = useSettings((s) => s.setProfile);
  const setTheme = useSettings((s) => s.setTheme);
  const theme = useSettings((s) => s.themeByProfile[s.profile] ?? PROFILES[s.profile].theme);
  const density = useSettings((s) => s.density);
  const showGrid = useSettings((s) => s.showGrid);
  const invLayout = useSettings((s) => s.invLayout);
  const token = useSettings((s) => s.token);
  const set = useSettings((s) => s.set);

  const [tokenDraft, setTokenDraft] = useState(token ?? '');
  const [tokenSaved, setTokenSaved] = useState(false);

  const name = PROFILES[profile].name;

  const saveToken = () => {
    set({ token: tokenDraft.trim() || null });
    setTokenSaved(true);
    window.setTimeout(() => setTokenSaved(false), 1800);
  };

  return (
    <>
      <div className="m-head">
        <div className="m-kicker mono up">
          <span className="tick" />
          ACCOUNT
        </div>
        <div className="m-h1">Me</div>
      </div>
      <div className="m-pad m-pad-b" style={{ paddingTop: 6 }}>
        <div className="m-profile">
          <div className="big-av">{name.charAt(0).toUpperCase()}</div>
          <div>
            <div className="nm">{name}</div>
            <div className="sub">SHARED DECK · 2 MEMBERS</div>
          </div>
        </div>

        <div className="m-cat mono up">
          <span>VIEWING AS</span>
          <span className="ln" />
        </div>
        <div className="m-set-row">
          <div className="l">Active member</div>
          <div className="m-seg">
            {PROFILE_ORDER.map((id) => (
              <button key={id} className={profile === id ? 'on' : ''} onClick={() => setProfile(id)}>
                {PROFILES[id].name}
              </button>
            ))}
          </div>
        </div>

        <div className="m-cat mono up">
          <span>APPEARANCE</span>
          <span className="ln" />
        </div>
        <div className="m-set-row">
          <div className="l">
            Theme
            <div className="sub">Saved per profile</div>
          </div>
          <div className="m-seg">
            {THEMES.map(([v, l]) => (
              <button key={v} className={theme === v ? 'on' : ''} onClick={() => setTheme(v)}>
                {l.slice(0, 4)}
              </button>
            ))}
          </div>
        </div>
        <div className="m-set-row">
          <div className="l">Density</div>
          <div className="m-seg">
            {DENSITIES.map((d) => (
              <button key={d} className={density === d ? 'on' : ''} onClick={() => set({ density: d })}>
                {d}
              </button>
            ))}
          </div>
        </div>
        <div className="m-set-row">
          <div className="l">Background grid</div>
          <button
            type="button"
            className={`m-toggle-sw${showGrid ? ' on' : ''}`}
            aria-pressed={showGrid}
            aria-label="Toggle background grid"
            onClick={() => set({ showGrid: !showGrid })}
          >
            <i />
          </button>
        </div>
        <div className="m-set-row">
          <div className="l">Inventory layout</div>
          <div className="m-seg">
            {(['list', 'grid'] as const).map((v) => (
              <button key={v} className={invLayout === v ? 'on' : ''} onClick={() => set({ invLayout: v })}>
                {v.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="m-cat mono up">
          <span>CONNECTION</span>
          <span className="ln" />
        </div>
        <div style={{ padding: '12px 4px' }}>
          <div className="m-field-l" style={{ marginTop: 0 }}>
            Todoist API token
          </div>
          <input
            className="m-input"
            type="password"
            autoComplete="off"
            value={tokenDraft}
            placeholder="Paste your Todoist token"
            onChange={(e) => setTokenDraft(e.target.value)}
          />
          <button
            className="m-sheet-add"
            style={{ marginTop: 12, height: 46 }}
            disabled={tokenDraft.trim() === (token ?? '')}
            onClick={saveToken}
          >
            {tokenSaved ? 'Saved ✓' : 'Save token'}
          </button>
        </div>
      </div>
    </>
  );
}
