export interface SavedInstallation {
  id: string;
  origin: string;
  name?: string | null;
}
export function startupInstallation(
  state: {
    active: SavedInstallation | null;
    preferences: { installations: SavedInstallation[]; defaultInstallationId: string | null; openOnStartup: boolean };
  },
  pendingLink: unknown
): SavedInstallation | null {
  if (pendingLink || state.active || !state.preferences.openOnStartup) return null;
  return state.preferences.installations.find((entry) => entry.id === state.preferences.defaultInstallationId) ?? null;
}
