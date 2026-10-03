export interface DesktopCallState {
  version: 1;
  inVoice: boolean;
  microphone: boolean;
  camera: boolean;
  screen: boolean;
  computerAudio: boolean;
  capture: boolean;
  pendingJoin: boolean;
  pendingCapture: boolean;
  microphoneTest: boolean;
}

interface StateBridge {
  version: 1;
  subscribe(provider: () => DesktopCallState): () => void;
}

declare global {
  interface Window { __VOXLY_DESKTOP_STATE_V1__?: StateBridge }
}

/** Sample existing track/lifecycle state; never publish names or room identifiers. */
export function desktopCallState(input: {
  inVoice: boolean;
  streams: Partial<Record<"mic" | "camera" | "screen", Pick<MediaStream, "getTracks">>>;
  pendingJoin: boolean;
  pendingCapture: boolean;
}): DesktopCallState {
  const live = (kind: "mic" | "camera" | "screen", type?: string, enabled = false) =>
    input.streams[kind]?.getTracks().some((track) => track.readyState === "live"
      && (!type || track.kind === type) && (!enabled || track.enabled)) ?? false;
  return {
    version: 1,
    inVoice: input.inVoice,
    microphone: live("mic", "audio", true),
    camera: live("camera", "video", true),
    screen: live("screen", "video", true),
    computerAudio: live("screen", "audio", true),
    capture: live("mic") || live("camera") || live("screen"),
    pendingJoin: input.pendingJoin,
    pendingCapture: input.pendingCapture,
    microphoneTest: false
  };
}

/** Count outstanding acquisition even when its owning join has been cancelled. */
export function createPendingCaptures() {
  let count = 0;
  return {
    isPending: () => count > 0,
    async run<T>(capture: () => Promise<T>): Promise<T> {
      count += 1;
      try { return await capture(); }
      finally { count -= 1; }
    }
  };
}

export function subscribeDesktopCallState(target: Pick<Window, "__VOXLY_DESKTOP_STATE_V1__">, provider: () => DesktopCallState): () => void {
  const bridge = target.__VOXLY_DESKTOP_STATE_V1__;
  if (bridge?.version !== 1 || typeof bridge.subscribe !== "function") return () => {};
  return bridge.subscribe(provider);
}
