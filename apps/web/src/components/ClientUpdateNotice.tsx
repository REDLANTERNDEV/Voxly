import type { Translate } from "../app/types.js";
import type { ReactNode } from "react";
import { useClientUpdate } from "../lib/useClientUpdate.js";

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
  return <>{children}{update.pendingVersion ? <aside className="client-update-notice" aria-label={t("clientUpdate.ready")}>
    <p role="status">{t(busy ? "clientUpdate.afterCall" : "clientUpdate.ready")}</p>
    <button className="btn" type="button" disabled={busy} onClick={update.reloadWhenSafe}>{t("clientUpdate.reload")}</button>
  </aside> : null}</>;
}
