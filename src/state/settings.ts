import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'bone' | 'eclipse' | 'vapor';
export type Density = 'compact' | 'regular' | 'comfy';
export type InvDisplay = 'stacked' | 'inline' | 'toggle';

interface SettingsState {
  theme: Theme;
  accent: string | null;
  density: Density;
  showGrid: boolean;
  invDisplay: InvDisplay;
  token: string | null;
  set: (patch: Partial<Omit<SettingsState, 'set'>>) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'vapor',
      accent: null,
      density: 'compact',
      showGrid: true,
      invDisplay: 'stacked',
      token: null,
      set: (patch) => set((s) => ({ ...s, ...patch })),
    }),
    {
      name: 'fairplay-settings',
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
