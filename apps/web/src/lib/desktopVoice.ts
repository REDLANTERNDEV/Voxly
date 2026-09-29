/** Native sends one fixed intent. Installation JavaScript gets no native IPC. */
export interface DesktopVoiceBridge {
  version: 1;
  subscribeMute(handler: () => void): () => void;
}

export function subscribeDesktopMute(target: { __VOXLY_DESKTOP_V1__?: DesktopVoiceBridge }, handler: () => void): () => void {
  const bridge = target.__VOXLY_DESKTOP_V1__;
  if (bridge?.version !== 1 || typeof bridge.subscribeMute !== "function") return () => {};
  return bridge.subscribeMute(handler);
}

export function desktopMuteAllowed(state: {
  inVoice: boolean;
  connected: boolean;
  liveMicrophone: boolean;
  deafened: boolean;
  ownerMuted: boolean;
  ownerDeafened: boolean;
  roomLocked: boolean;
}): boolean {
  return state.inVoice && state.connected && state.liveMicrophone
    && !state.deafened && !state.ownerMuted && !state.ownerDeafened && !state.roomLocked;
}

export function createDesktopMuteReceiver(state: () => Parameters<typeof desktopMuteAllowed>[0], toggle: () => Promise<void>): () => void {
  let pending = false;
  return () => {
    if (pending || !desktopMuteAllowed(state())) return;
    pending = true;
    void (async () => {
      try { await toggle(); }
      finally { pending = false; }
    })().catch(() => undefined);
  };
}

declare global {
  interface Window { __VOXLY_DESKTOP_V1__?: DesktopVoiceBridge }
}
