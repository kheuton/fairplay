import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { PROFILES, PROFILE_ORDER, DEFAULT_PROFILE, type ProfileId } from '../cards/deck-config';

// Re-export Theme from canonical location so all existing imports keep working.
export type { Theme } from '../lib/types';
export type { ProfileId };

export type Density = 'compact' | 'regular' | 'comfy';
export type InvDisplay = 'stacked' | 'inline' | 'toggle';
export type InvLayout = 'list' | 'grid';

// Build the default themeByProfile from PROFILES at module load time.
const DEFAULT_THEME_BY_PROFILE = Object.fromEntries(
  PROFILE_ORDER.map((id) => [id, PROFILES[id].theme])
) as Record<ProfileId, import('../lib/types').Theme>;

interface SettingsState {
  profile: ProfileId;
  themeByProfile: Record<ProfileId, import('../lib/types').Theme>;
  accent: string | null;
  density: Density;
  showGrid: boolean;
  invDisplay: InvDisplay;
  invLayout: InvLayout;
  token: string | null;
  setProfile: (p: ProfileId) => void;
  setTheme: (t: import('../lib/types').Theme) => void;
  set: (patch: Partial<Omit<SettingsState, 'set' | 'setProfile' | 'setTheme'>>) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      profile: DEFAULT_PROFILE,
      themeByProfile: { ...DEFAULT_THEME_BY_PROFILE },
      accent: null,
      density: 'compact',
      showGrid: true,
      invDisplay: 'stacked',
      // Default shallow-merge guarantee: a persisted blob lacking invLayout keeps 'list'
      // without any migrate branch or version bump.
      invLayout: 'list',
      token: null,
      setProfile: (p) => set(() => ({ profile: p })),
      setTheme: (t) =>
        set((s) => ({
          themeByProfile: { ...s.themeByProfile, [s.profile]: t },
        })),
      set: (patch) => set((s) => ({ ...s, ...patch })),
    }),
    {
      name: 'fairplay-settings',
      version: 1,
      migrate(persisted: unknown, version: number) {
        if (version < 1) {
          const p = (persisted ?? {}) as Record<string, unknown>;
          const oldTheme = typeof p.theme === 'string' ? p.theme : undefined;
          const { theme: _dropped, ...rest } = p;
          void _dropped;
          return {
            ...rest,
            profile: DEFAULT_PROFILE,
            themeByProfile: {
              amy: PROFILES.amy.theme,
              kyle: (oldTheme as import('../lib/types').Theme | undefined) ?? PROFILES.kyle.theme,
            },
          };
        }
        return persisted;
      },
    }
  )
);

export function getToken(): string | null {
  const storeToken = useSettings.getState().token;
  if (storeToken) return storeToken;
  const envToken = import.meta.env.VITE_TODOIST_API_TOKEN as string | undefined;
  if (envToken && envToken.trim()) return envToken.trim();
  return null;
}

export const useProfile = () => useSettings((s) => s.profile);

export function getProfile(): ProfileId {
  return useSettings.getState().profile;
}
