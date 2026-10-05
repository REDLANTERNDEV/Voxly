import { initialScreenQuality, screenQualityProfiles, screenSenderSample, stepScreenQuality } from "./screenQuality.js";
import { safeScreenStats, voiceDiagnostics } from "./voiceDiagnostics.js";

/** One sender generation; at most one async measurement/parameter write is in flight. */
export class ScreenQualityController {
  private state = initialScreenQuality();
  private disposed = false;
  private busy = false;
  private configured = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly sender: RTCRtpSender, private readonly track: MediaStreamTrack,
    private readonly current: () => boolean, private readonly peer?: RTCPeerConnection) {}
  private live() { return !this.disposed && this.current() && this.sender.track === this.track && this.track.readyState === "live"; }
  start() {
    if (this.timer || this.disposed) return;
    void this.sample(false);
    this.timer = setInterval(() => void this.sample(true), 2_000);
    this.track.addEventListener("ended", this.end);
  }
  private end = () => this.dispose();
  dispose() { this.disposed = true; clearInterval(this.timer); this.timer = undefined; this.track.removeEventListener("ended", this.end); }
  private async apply() {
    if (!this.live()) return false;
    const parameters = this.sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: "maintain-framerate" };
    // Some browsers expose no encodings until negotiation; retry at the next sample.
    if (!parameters.encodings?.length) return false;
    parameters.degradationPreference = "maintain-framerate";
    for (const encoding of parameters.encodings) Object.assign(encoding, screenQualityProfiles[this.state.profile]);
    await this.sender.setParameters(parameters);
    return this.live();
  }
  async sample(advance = true) {
    if (this.busy || !this.live()) return;
    this.busy = true;
    try {
      if (!this.configured) { this.configured = await this.apply(); if (!this.configured || !this.live()) return; }
      if (!advance) return;
      let report: Record<string, unknown>[] | null = null;
      try { report = []; (await this.sender.getStats()).forEach(entry => report!.push(entry as Record<string, unknown>)); }
      catch { report = null; }
      if (!this.live()) return;
      // No outbound media yet is not evidence of a healthy connection.
      const sample = report === null ? {} : screenSenderSample(report);
      if (report) voiceDiagnostics.record("screen", { direction: "send", profile: this.state.profile,
        capture: { width: this.track.getSettings().width, height: this.track.getSettings().height, frameRate: this.track.getSettings().frameRate },
        video: safeScreenStats(report), sample }, this.peer);
      if (sample === null) return;
      const next = stepScreenQuality(this.state, sample);
      const changed = next.profile !== this.state.profile;
      this.state = next;
      if (changed) await this.apply();
    } catch { this.dispose(); /* A rejected parameter set falls back to browser-native adaptation. */ }
    finally { this.busy = false; }
  }
}

/** Repeated track synchronization retains startup/recovery state for a viewer. */
export class ScreenQualityOwner {
  private entries = new Map<string, { peer: RTCPeerConnection; sender: RTCRtpSender; track: MediaStreamTrack; controller: ScreenQualityController }>();
  sync(userId: string, peer: RTCPeerConnection, sender: RTCRtpSender | null, track: MediaStreamTrack | null) {
    const previous = this.entries.get(userId);
    if (previous?.peer === peer && previous.sender === sender && previous.track === track) return;
    previous?.controller.dispose(); this.entries.delete(userId);
    if (!sender || !track) return;
    const entry = { peer, sender, track, controller: null as unknown as ScreenQualityController };
    entry.controller = new ScreenQualityController(sender, track, () => this.entries.get(userId) === entry && peer.connectionState !== "closed", peer);
    this.entries.set(userId, entry); entry.controller.start();
  }
  release(userId: string) { this.entries.get(userId)?.controller.dispose(); this.entries.delete(userId); }
  clear() { for (const userId of this.entries.keys()) this.release(userId); }
}
