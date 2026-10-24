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

/**
 * A `voxly://open` link can come from any web page. One that names a saved
 * Installation opens directly; any other address waits for the member's local
 * Open (ADR-0027), so a stranger's site cannot load here — or save itself as the
 * startup Installation — on the strength of a link alone.
 */
export function desktopLinkNeedsConfirmation(
  target: { id: string; origin: string; launchId: string | null },
  preferences: { installations: SavedInstallation[] } | undefined
): boolean {
  return !preferences?.installations.some((entry) => entry.id === target.id);
}
