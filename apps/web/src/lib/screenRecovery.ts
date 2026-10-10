/** Presentation state; ready includes the quiet grace period after prior decoded playback. */
export type ScreenPlaybackStatus = "connecting" | "reconnecting" | "failed" | "ready";
export interface ScreenRecoveryTarget {
  publisherId: string;
  peer: RTCPeerConnection | null;
  receiver: RTCRtpReceiver | null;
}
interface Entry extends ScreenRecoveryTarget {
  startedAt: number;
  ready: boolean;
  played: boolean;
  interruptedAt: number | null;
  unavailableSince: number | null;
  faultSince: number | null;
  lastRepairAt: number | null;
  busy: boolean;
  status: ScreenPlaybackStatus;
  presentationTimer?: ReturnType<typeof setTimeout>;
}

/** A subscription owns its deadline; transport connectivity is not a frame. */
export class ScreenRecoveryOwner {
  private entries = new Map<string, Entry>();
  private sampling = false;
  private disposed = false;
  constructor(
    private repair: (publisherId: string, peer: RTCPeerConnection | null, isCurrent: () => boolean) => Promise<void>,
    private changed: (statuses: Record<string, ScreenPlaybackStatus>) => void,
    private now: () => number = Date.now
  ) {}

  sync(targets: readonly ScreenRecoveryTarget[]) {
    if (this.disposed) return;
    const selected = new Set(targets.map((target) => target.publisherId));
    let changed = false;
    for (const [id, entry] of this.entries)
      if (!selected.has(id)) {
        this.clearPresentationTimer(entry);
        this.entries.delete(id);
        changed = true;
      }
    for (const target of targets) {
      const old = this.entries.get(target.publisherId);
      if (old?.peer === target.peer && old.receiver === target.receiver) continue;
      if (old) this.clearPresentationTimer(old);
      const entry: Entry = {
        ...target,
        startedAt: old && !old.ready ? old.startedAt : this.now(),
        ready: false,
        played: old?.played ?? false,
        interruptedAt: old?.played ? (old.interruptedAt ?? this.now()) : null,
        unavailableSince: null,
        faultSince: old?.faultSince ?? null,
        lastRepairAt: old?.lastRepairAt ?? null,
        busy: false,
        status:
          old?.status === "failed"
            ? "failed"
            : old?.played && (old.interruptedAt === null || this.now() - old.interruptedAt < 5_000)
              ? "ready"
              : old
                ? "reconnecting"
                : "connecting"
      };
      this.entries.set(target.publisherId, entry);
      if (entry.played && entry.status !== "failed") this.presentInterruption(entry, this.now());
      changed = true;
    }
    if (changed) this.publish();
  }
  private clearPresentationTimer(entry: Entry) {
    if (entry.presentationTimer !== undefined) clearTimeout(entry.presentationTimer);
    entry.presentationTimer = undefined;
  }
  private presentInterruption(entry: Entry, now: number) {
    entry.interruptedAt ??= now;
    const remaining = 5_000 - (now - entry.interruptedAt);
    this.update(entry, remaining <= 0 ? "reconnecting" : "ready");
    if (remaining > 0 && entry.presentationTimer === undefined) {
      entry.presentationTimer = setTimeout(() => {
        entry.presentationTimer = undefined;
        if (
          !this.disposed &&
          this.entries.get(entry.publisherId) === entry &&
          entry.interruptedAt !== null &&
          this.now() - entry.interruptedAt >= 5_000
        )
          this.update(entry, "reconnecting");
      }, remaining);
      // Node fixtures must not be kept alive by a presentation-only timer.
      const timer = entry.presentationTimer;
      if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref();
    }
  }
  private publish() {
    this.changed(Object.fromEntries([...this.entries].map(([id, entry]) => [id, entry.status])));
  }
  private update(entry: Entry, status: ScreenPlaybackStatus) {
    if (entry.status !== status) {
      entry.status = status;
      this.publish();
    }
  }
  status(id: string) {
    return this.entries.get(id)?.status;
  }
  notePlayback(id: string, track: MediaStreamTrack) {
    const entry = this.entries.get(id);
    if (
      !entry ||
      entry.status === "failed" ||
      entry.receiver?.track !== track ||
      track.readyState !== "live" ||
      track.muted
    )
      return;
    entry.ready = true;
    entry.played = true;
    this.clearPresentationTimer(entry);
    entry.interruptedAt = null;
    entry.faultSince = null;
    entry.unavailableSince = null;
    this.update(entry, "ready");
  }
  retry(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.clearPresentationTimer(entry);
    entry.startedAt = this.now() - 10_000;
    entry.ready = false;
    entry.interruptedAt = this.now() - 5_000;
    entry.faultSince = null;
    entry.lastRepairAt = null;
    this.update(entry, "reconnecting");
  }
  async sample() {
    if (this.disposed || this.sampling) return;
    this.sampling = true;
    try {
      for (const [id, entry] of this.entries) {
        if (entry.status === "failed" || entry.busy) continue;
        const track = entry.receiver?.track;
        if (!entry.ready && track?.readyState === "live" && !track.muted) {
          try {
            const report = await entry.receiver!.getStats();
            if (this.entries.get(id) !== entry || this.disposed) continue;
            let decoded = false;
            report.forEach((stat) => {
              if (
                stat.type === "inbound-rtp" &&
                (stat.kind === "video" || stat.mediaType === "video") &&
                stat.framesDecoded > 0
              )
                decoded = true;
            });
            if (decoded) this.notePlayback(id, track);
          } catch {
            /* Playback callbacks remain available when statistics are unsupported. */
          }
        }
        if (this.entries.get(id) !== entry || this.disposed) continue;
        const now = this.now();
        const unavailable = track && (track.readyState === "ended" || track.muted);
        entry.unavailableSince = unavailable ? (entry.unavailableSince ?? now) : null;
        if (entry.played && (!entry.ready || unavailable)) {
          this.presentInterruption(entry, now);
        }
        const fault = entry.ready
          ? entry.unavailableSince !== null && now - entry.unavailableSince >= 4_000
          : now - entry.startedAt >= 10_000;
        if (!fault) {
          if (entry.ready && !unavailable) {
            entry.faultSince = null;
            entry.interruptedAt = null;
            this.clearPresentationTimer(entry);
            this.update(entry, "ready");
          }
          continue;
        }
        entry.faultSince ??= now;
        if (now - entry.faultSince >= 600_000) {
          this.clearPresentationTimer(entry);
          this.update(entry, "failed");
          continue;
        }
        if (entry.lastRepairAt !== null && now - entry.lastRepairAt < 15_000) continue;
        entry.busy = true;
        entry.lastRepairAt = now;
        if (!entry.played) this.update(entry, "reconnecting");
        try {
          await this.repair(id, entry.peer, () => !this.disposed && this.entries.get(id) === entry);
        } catch {
          /* The same subscription retries after the cooldown. */
        } finally {
          entry.busy = false;
        }
      }
    } finally {
      this.sampling = false;
    }
  }
  dispose() {
    this.disposed = true;
    for (const entry of this.entries.values()) this.clearPresentationTimer(entry);
    this.entries.clear();
  }
}
