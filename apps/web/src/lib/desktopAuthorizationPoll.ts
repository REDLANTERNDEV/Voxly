/** What the desktop window needs to follow one sign-in request to its end. */
export interface DesktopAuthorizationPoll {
  request: { id: string; secret: string; expiresInSeconds: number };
  collect: (id: string, secret: string) => Promise<{ status: string }>;
  remember: (status: string, isCurrent: () => boolean) => Promise<void>;
  restore: () => Promise<void>;
  onLinked: () => void;
  onOutcome: (outcome: "refused" | "expired") => void;
  /** This poll loop is still the one the component is running. */
  isLive: () => boolean;
  /** The sign-in screen is still on the page. */
  isMounted: () => boolean;
  /** The component still holds this request as its current one. */
  holdsRequest: () => boolean;
  releaseRequest: () => void;
  schedule: (run: () => void, delayMs: number) => () => void;
  now: () => number;
}

/**
 * How long a native window call may take before sign-in carries on without it.
 * Remembering the Installation and restoring the window are niceties; the
 * session cookie is already set, so neither may hold the member on this screen.
 */
export const nativeStepLimitMs = 3000;

function within(step: Promise<unknown>, limitMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    step.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, limitMs);
    })
  ]).finally(() => clearTimeout(timer));
}

/**
 * Polls one desktop sign-in request until the browser answers it.
 *
 * Approval is a point of no return: the server has consumed the request and set
 * the session cookie in that response. From there the sign-in is finished by
 * this run even if the component restarts its effect meanwhile — a restarted run
 * sees the request released and stops, so abandoning here would leave the
 * window on the code card until the app is reopened.
 */
export function pollDesktopAuthorization(poll: DesktopAuthorizationPoll): () => void {
  let delay = 1500;
  let cancelTimer = () => {};
  const deadline = poll.now() + poll.request.expiresInSeconds * 1000;
  const run = async () => {
    if (poll.now() >= deadline) {
      void poll.restore();
      poll.releaseRequest();
      poll.onOutcome("expired");
      return;
    }
    try {
      const response = await poll.collect(poll.request.id, poll.request.secret);
      if (!poll.isLive() || !poll.holdsRequest()) return;
      if (response.status === "approved") {
        poll.releaseRequest();
        await within(poll.remember(response.status, poll.isMounted), nativeStepLimitMs);
        await within(poll.restore(), nativeStepLimitMs);
        if (poll.isMounted()) poll.onLinked();
        return;
      }
      if (response.status !== "pending") {
        void poll.restore();
        poll.releaseRequest();
        poll.onOutcome(response.status === "refused" ? "refused" : "expired");
        return;
      }
    } catch {
      // A transient network failure should not consume the request.
    }
    if (poll.isLive()) {
      delay = Math.min(delay + 750, 5000);
      cancelTimer = poll.schedule(() => void run(), delay);
    }
  };
  cancelTimer = poll.schedule(() => void run(), delay);
  return () => cancelTimer();
}
