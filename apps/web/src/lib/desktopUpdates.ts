export interface DesktopUpdateSnapshot {
  currentVersion: string;
  phase: "disabled" | "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "error";
  version: string | null;
  error: string | null;
}
export interface DesktopUpdateBridge {
  version: 1;
  read(): Promise<unknown>;
  review(): Promise<boolean>;
  subscribe(handler: (snapshot: unknown) => void): () => void;
}
const phases = ["disabled", "idle", "checking", "current", "available", "downloading", "ready", "installing", "error"];
const releaseVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

export function desktopUpdateSnapshot(value: unknown): DesktopUpdateSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.currentVersion !== "string" ||
    candidate.currentVersion.length > 80 ||
    !releaseVersion.test(candidate.currentVersion) ||
    typeof candidate.phase !== "string" ||
    !phases.includes(candidate.phase) ||
    !(
      candidate.version === null ||
      (typeof candidate.version === "string" &&
        candidate.version.length <= 80 &&
        releaseVersion.test(candidate.version))
    ) ||
    !(candidate.error === null || (typeof candidate.error === "string" && candidate.error.length <= 80))
  )
    return null;
  return {
    currentVersion: candidate.currentVersion,
    phase: candidate.phase as DesktopUpdateSnapshot["phase"],
    version: candidate.version as string | null,
    error: candidate.error as string | null
  };
}

export function desktopUpdateBridge(
  runtime: unknown = typeof window === "undefined" ? null : window
): DesktopUpdateBridge | null {
  const bridge = (runtime as { __VOXLY_DESKTOP_UPDATES_V1__?: DesktopUpdateBridge } | null)
    ?.__VOXLY_DESKTOP_UPDATES_V1__;
  return bridge?.version === 1 &&
    typeof bridge.read === "function" &&
    typeof bridge.review === "function" &&
    typeof bridge.subscribe === "function"
    ? bridge
    : null;
}

/** Native checks/downloads continue independently; this only observes local memory. */
export function observeDesktopUpdates(
  bridge: DesktopUpdateBridge,
  receive: (snapshot: DesktopUpdateSnapshot) => void,
  timers: Pick<typeof globalThis, "setInterval" | "clearInterval"> = globalThis
) {
  let disposed = false;
  let checking = false;
  let revision = 0;
  const publish = (value: unknown) => {
    const snapshot = desktopUpdateSnapshot(value);
    if (!disposed && snapshot) receive(snapshot);
  };
  let unsubscribe = () => {};
  try {
    unsubscribe = bridge.subscribe((value) => {
      revision++;
      publish(value);
    });
  } catch {
    /* Polling still works if an older bridge cannot subscribe. */
  }
  const check = async () => {
    if (disposed || checking) return;
    checking = true;
    const started = revision;
    try {
      const value = await bridge.read();
      if (started === revision) publish(value);
    } catch {
      /* A temporarily unavailable bridge does not erase a verified-ready notice. */
    } finally {
      checking = false;
    }
  };
  void check();
  const timer = timers.setInterval(() => void check(), 60_000);
  return () => {
    disposed = true;
    unsubscribe();
    timers.clearInterval(timer);
  };
}

export function desktopUpdateNotice(snapshot: DesktopUpdateSnapshot | null) {
  if (!snapshot || snapshot.phase === "disabled" || snapshot.error === "update_cancelled") return null;
  if (snapshot.error === "update_review_failed") return "reviewError";
  if (snapshot.error)
    return snapshot.error === "update_signature" || snapshot.error === "update_invalid" ? "invalid" : "error";
  return ["available", "downloading", "ready", "installing"].includes(snapshot.phase)
    ? (snapshot.phase as "available" | "downloading" | "ready" | "installing")
    : null;
}
