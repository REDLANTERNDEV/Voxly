import { validDesktopMicrophoneState, type DesktopMicrophoneState } from "./desktopMicrophone.js";

/** Native sends fixed intents. Installation JavaScript gets no native IPC. */
export interface DesktopVoiceBridge {
  version: 1;
  subscribeMute(handler: () => void): () => void;
  subscribeDeafen?(handler: () => void): () => void;
  getMicrophoneState?(): DesktopMicrophoneState;
  subscribeMicrophone?(handler: (state: DesktopMicrophoneState) => void): () => void;
}

export function readDesktopMicrophoneState(target: { __VOXLY_DESKTOP_V1__?: DesktopVoiceBridge }): DesktopMicrophoneState {
  const bridge = target.__VOXLY_DESKTOP_V1__;
  const state = bridge?.version === 1 ? bridge.getMicrophoneState?.() : undefined;
  return validDesktopMicrophoneState(state) ? state : { mode: "openMic", talkHeld: false, muteHeld: false };
}

export function subscribeDesktopMicrophone(target: { __VOXLY_DESKTOP_V1__?: DesktopVoiceBridge }, handler: (state: DesktopMicrophoneState) => void): () => void {
  const bridge = target.__VOXLY_DESKTOP_V1__;
  if (bridge?.version !== 1 || typeof bridge.subscribeMicrophone !== "function") return () => {};
  return bridge.subscribeMicrophone((state) => { if (validDesktopMicrophoneState(state)) handler(state); });
}

export function subscribeDesktopMute(target: { __VOXLY_DESKTOP_V1__?: DesktopVoiceBridge }, handler: () => void): () => void {
  const bridge = target.__VOXLY_DESKTOP_V1__;
  if (bridge?.version !== 1 || typeof bridge.subscribeMute !== "function") return () => {};
  return bridge.subscribeMute(handler);
}

export function subscribeDesktopDeafen(target: { __VOXLY_DESKTOP_V1__?: DesktopVoiceBridge }, handler: () => void): () => void {
  const bridge = target.__VOXLY_DESKTOP_V1__;
  if (bridge?.version !== 1 || typeof bridge.subscribeDeafen !== "function") return () => {};
  return bridge.subscribeDeafen(handler);
}

export function desktopDeafenAllowed(state: {
  inVoice: boolean;
  connected: boolean;
  ownerDeafened: boolean;
  microphoneTest: boolean;
}): boolean {
  return state.inVoice && state.connected && !state.ownerDeafened && !state.microphoneTest;
}

export function createDesktopDeafenReceiver(state: () => Parameters<typeof desktopDeafenAllowed>[0], toggle: () => Promise<boolean>): () => void {
  return () => {
    if (desktopDeafenAllowed(state())) void toggle().catch(() => undefined);
  };
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
  return () => {
    if (!desktopMuteAllowed(state())) return;
    // The local microphone changes before the server acknowledgement arrives.
    // A second physical press must not be lost while that acknowledgement waits.
    void toggle().catch(() => undefined);
  };
}

declare global {
  interface Window { __VOXLY_DESKTOP_V1__?: DesktopVoiceBridge }
}
