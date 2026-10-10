// Disposable data; this module is aliased only by the regression fixture config.
const state = {
  preferences: {
    installations: [
      { id: "acme", name: "Acme Crew", origin: "https://chat.example.com" },
      { id: "family", name: "Family Chat", origin: "https://family.example.com" },
      { id: "dev", name: "Dev Sandbox", origin: "https://dev.example.com" }
    ],
    defaultInstallationId: "acme",
    openOnStartup: false,
    display: { fullAddresses: true, compactList: false, installationIcons: true },
    language: "en",
    trayAcknowledged: true,
    muteShortcut: "Control+Shift+KeyM",
    deafenShortcut: "Control+Shift+KeyD",
    pushToTalkShortcut: null,
    pushToMuteShortcut: null,
    microphoneMode: "openMic",
    pushToTalkReleaseDelayMs: 0
  },
  active: null,
  loading: false,
  platform: "windows",
  shellVersion: "0.1.0",
  registeredMuteShortcut: "Control+Shift+KeyM",
  registeredDeafenShortcut: "Control+Shift+KeyD",
  registeredPushToTalkShortcut: null,
  registeredPushToMuteShortcut: null
};
export const isTauri = () => true;
export async function invoke(command, args = {}) {
  if (command === "take_desktop_link") return null;
  if (command === "take_tray_update_check") return false;
  if (command === "shell_update_state")
    return { currentVersion: "0.1.0", phase: "disabled", version: null, downloaded: 0, total: null, error: null };
  if (command === "transition_state") return null;
  if (command === "desktop_settings") {
    if (args.operation.kind === "default") {
      state.preferences.defaultInstallationId = args.operation.id;
      state.preferences.openOnStartup = Boolean(args.operation.id && args.operation.enabled);
    } else if (args.operation.kind === "rename")
      state.preferences.installations.find((x) => x.id === args.operation.id).name = args.operation.name;
    else if (args.operation.kind === "display") state.preferences.display = args.operation.display;
  }
  if (command === "set_language") state.preferences.language = args.language;
  if (command === "forget_installation")
    state.preferences.installations = state.preferences.installations.filter((x) => x.id !== args.id);
  return structuredClone(state);
}
