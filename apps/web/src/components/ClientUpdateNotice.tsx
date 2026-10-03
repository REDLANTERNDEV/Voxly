import type { Translate } from "../app/types.js";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useClientUpdate } from "../lib/useClientUpdate.js";
import { ApplicationUpdateContext } from "../lib/applicationUpdates.js";
import { desktopUpdateBridge, observeDesktopUpdates, type DesktopUpdateSnapshot } from "../lib/desktopUpdates.js";

export function ClientUpdateBoundary({ latestVersion, media, t, children }: {
  latestVersion: string | null;
  media: {
    voice: { activeRoomId: string | null; joinPending: boolean; isJoinPending: () => boolean; microphoneMonitorStream: MediaStream | null; localPreviews: readonly unknown[] };
    microphoneTest: { active: boolean };
  };
  t: Translate;
  children: ReactNode;
}) {
  const busy = Boolean(media.voice.joinPending || media.voice.activeRoomId || media.voice.microphoneMonitorStream
    || media.voice.localPreviews.length || media.microphoneTest.active);
  const update = useClientUpdate(latestVersion, busy, media.voice.isJoinPending);
  const [desktop, setDesktop] = useState<DesktopUpdateSnapshot | null>(null);
  useEffect(() => {
    const bridge = desktopUpdateBridge();
    return bridge ? observeDesktopUpdates(bridge, setDesktop) : undefined;
  }, []);
  const reviewDesktop = useCallback(async () => {
    let shown = false;
    try { shown = await desktopUpdateBridge()?.review() ?? false; } catch { /* Present failure in the same update row. */ }
    if (!shown) setDesktop(current => current ? { ...current, error: "update_review_failed" } : current);
  }, []);
  const context = useMemo(() => ({ desktop, reviewDesktop, pendingClient: update.pendingVersion, clientBusy: busy, reloadClient: update.reloadWhenSafe }), [desktop, reviewDesktop, update.pendingVersion, busy, update.reloadWhenSafe]);
  return <ApplicationUpdateContext value={context}>{children}</ApplicationUpdateContext>;
}
