import type { ReactNode } from "react";
import { ReconnectOverlay } from "../components/shell/VoiceDock.js";
import type { ConnectionHealth } from "../lib/useConnectionHealth.js";
import type { Translate } from "./types.js";

export function AuthenticatedAppSurface({ audio, children, connectionHealth, t }: {
  audio: ReactNode;
  children: ReactNode;
  connectionHealth?: ConnectionHealth;
  t?: Translate;
}) {
  const blocked = Boolean(connectionHealth?.overlayVisible);
  return <>{audio}<div className="authenticated-surface" inert={blocked ? true : undefined}>{children}</div>{blocked && connectionHealth && t ? <ReconnectOverlay health={connectionHealth} t={t} /> : null}</>;
}
