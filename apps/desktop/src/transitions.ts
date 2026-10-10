export interface CallState {
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

/** Close button, Alt+F4 and tray requests share one pending quit decision. */
export function createQuitRequest(request: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return () => {
    if (pending) return pending;
    pending = Promise.resolve()
      .then(request)
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}

export function needsConfirmation(active: boolean, report: CallState | null, localMedia: boolean): boolean {
  return (
    localMedia ||
    (active &&
      (!report ||
        report.version !== 1 ||
        Object.entries(report).some(([key, value]) => key !== "version" && value === true)))
  );
}

/** Native rechecks after health checks; new capture can require another prompt. */
export async function performTransition<T>(options: {
  active: boolean;
  report: () => Promise<CallState | null>;
  localMedia: () => boolean;
  confirm: (report: CallState | null) => Promise<boolean>;
  stop: () => void;
  action: (confirmed: boolean) => Promise<T>;
}): Promise<T | undefined> {
  const report = options.active ? await options.report().catch(() => null) : null;
  let confirmed = false;
  if (needsConfirmation(options.active, report, options.localMedia())) {
    if (!(await options.confirm(report))) return;
    confirmed = true;
  }
  options.stop();
  try {
    return await options.action(confirmed);
  } catch (error) {
    if (confirmed || error !== "confirmation_required") throw error;
    if (!(await options.confirm(null))) return;
    options.stop();
    return options.action(true);
  }
}
