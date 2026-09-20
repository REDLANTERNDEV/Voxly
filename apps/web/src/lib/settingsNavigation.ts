export const settingsRequestEvent = "voxly:settings-request";

export type RequestedSettingsSection = "privacy";

export function requestSettingsSection(section: RequestedSettingsSection) {
  window.dispatchEvent(new CustomEvent<RequestedSettingsSection>(settingsRequestEvent, { detail: section }));
}
