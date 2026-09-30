export type DesktopMicrophoneMode = "openMic" | "pushToTalk" | "pushToMute";
export interface DesktopMicrophoneState {
  mode: DesktopMicrophoneMode;
  talkHeld: boolean;
  muteHeld: boolean;
  talkReleasing?: boolean;
}

export function validDesktopMicrophoneState(value: unknown): value is DesktopMicrophoneState {
  if (!value || typeof value !== "object") return false;
  const state = value as DesktopMicrophoneState;
  return ["openMic", "pushToTalk", "pushToMute"].includes(state.mode)
    && typeof state.talkHeld === "boolean" && typeof state.muteHeld === "boolean"
    && (state.talkReleasing === undefined || typeof state.talkReleasing === "boolean");
}

/** A publication gate, separate from self mute and microphone capture. */
export class DesktopMicrophoneGate {
  private mode: DesktopMicrophoneMode;
  private talkHeld = false;
  private muteHeld = false;
  private observedTalkHeld = false;
  private blockedTalk = false;
  private talkTailAllowed = false;
  private tracks = new Map<Pick<MediaStreamTrack, "enabled" | "readyState">, boolean>();

  constructor(mode: DesktopMicrophoneMode = "openMic") { this.mode = mode; }

  update(state: DesktopMicrophoneState, allowed: boolean) {
    if (state.mode !== this.mode) {
      this.mode = state.mode;
      this.resetHolds();
    }
    if (!state.talkHeld) this.blockedTalk = false;
    else if (!allowed) this.blockedTalk = true;
    this.observedTalkHeld = state.talkHeld;
    // A release tail can extend an existing grant, never create a new one.
    this.talkTailAllowed = state.talkReleasing === true && allowed && !this.blockedTalk
      && (this.talkHeld || this.talkTailAllowed);
    this.talkHeld = state.talkHeld && allowed && !this.blockedTalk;
    this.muteHeld = state.muteHeld;
    for (const [track, requested] of this.tracks) {
      if (track.readyState === "ended") this.tracks.delete(track);
      track.enabled = allowed && requested && this.allows() && track.readyState === "live";
    }
  }

  resetHolds() {
    this.blockedTalk = this.observedTalkHeld;
    this.talkHeld = false;
    this.talkTailAllowed = false;
    // Carry a mute across a room/device transition until its physical release.
  }

  allows() {
    if (this.mode === "pushToTalk") return this.talkHeld || this.talkTailAllowed;
    if (this.mode === "pushToMute") return !this.muteHeld;
    return true;
  }

  usesShortcut() { return this.mode !== "openMic"; }

  apply(tracks: ReadonlyArray<Pick<MediaStreamTrack, "enabled" | "readyState">>, requested: boolean) {
    for (const track of tracks) {
      if (track.readyState === "ended") { this.tracks.delete(track); track.enabled = false; continue; }
      this.tracks.set(track, requested);
      track.enabled = requested && this.allows() && track.readyState === "live";
    }
  }

  suspend() {
    this.resetHolds();
    for (const track of this.tracks.keys()) track.enabled = false;
  }

  forget(tracks: ReadonlyArray<Pick<MediaStreamTrack, "enabled" | "readyState">>) {
    for (const track of tracks) this.tracks.delete(track);
  }

  acceptedControl(accepted: boolean, requested: boolean) {
    // The server observes publication, while the button retains self-mute intent.
    // A reply to idle silence can arrive after a new press; it cannot self-mute.
    return this.usesShortcut() ? requested : accepted;
  }
}
