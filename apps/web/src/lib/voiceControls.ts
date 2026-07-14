import type { VoiceMediaState } from "@voxly/shared";

export type VoiceControlKey = "mic" | "deafen" | "camera" | "screenShare";

export interface VoiceControlState {
  on: boolean;
  enabled: boolean;
}

export type VoiceControls = Record<VoiceControlKey, VoiceControlState>;

export type VoiceControlAction = "muteMic" | "unmuteMic" | "deafen" | "undeafen" | "startCamera" | "stopCamera" | "startScreenShare" | "stopScreenShare";

export type VoiceControlTone = "neutral" | "danger";

export function createInitialVoiceControls(): VoiceControls {
  return {
    mic: { on: true, enabled: true },
    deafen: { on: false, enabled: true },
    camera: { on: false, enabled: true },
    screenShare: { on: false, enabled: true }
  };
}

export function toggleVoiceControl(controls: VoiceControls, key: VoiceControlKey, options: { microphoneAvailable?: boolean } = {}): VoiceControls {
  const current = controls[key];
  if (!current.enabled) {
    return controls;
  }

  if (key === "deafen") {
    const nextDeafen = !current.on;
    return {
      ...controls,
      mic: {
        ...controls.mic,
        on: !nextDeafen && options.microphoneAvailable !== false
      },
      deafen: {
        ...current,
        on: nextDeafen
      }
    };
  }

  return {
    ...controls,
    [key]: {
      ...current,
      on: !current.on
    }
  };
}

export function voiceDockStatus(controls: VoiceControls, connectedCount: number) {
  if (controls.deafen.on) {
    return "Deafened - voice output off";
  }

  if (!controls.mic.on) {
    return `Mic muted - ${connectedCount} connected`;
  }

  return `${connectedCount} connected`;
}

export function controlPresentation(key: VoiceControlKey, controls: VoiceControls): { action: VoiceControlAction; tone: VoiceControlTone } {
  if (key === "mic") {
    return controls.mic.on ? { action: "muteMic", tone: "neutral" } : { action: "unmuteMic", tone: "danger" };
  }
  if (key === "deafen") {
    return controls.deafen.on ? { action: "undeafen", tone: "danger" } : { action: "deafen", tone: "neutral" };
  }
  if (key === "camera") {
    return controls.camera.on ? { action: "stopCamera", tone: "neutral" } : { action: "startCamera", tone: "neutral" };
  }
  return controls.screenShare.on
    ? { action: "stopScreenShare", tone: "neutral" }
    : { action: "startScreenShare", tone: "neutral" };
}

export function voiceStatusLabels(media: VoiceMediaState) {
  const labels: string[] = [];
  if (media.deafened) labels.push("Deafened");
  if (!media.mic || media.deafened) labels.push("Muted");
  if (media.screen) labels.push("Screen");
  else if (media.camera) labels.push("Camera");
  if (media.speaking && media.mic && !media.deafened) labels.push("Speaking");
  return labels;
}
