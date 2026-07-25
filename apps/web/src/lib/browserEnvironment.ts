export function isSteamGameOverlay(userAgent: string) {
  return userAgent.toLowerCase().includes("valve steam gameoverlay");
}
