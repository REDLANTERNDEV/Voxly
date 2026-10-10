import { createContext, useContext } from "react";
import type { DesktopUpdateSnapshot } from "./desktopUpdates.js";

declare const __VOXLY_WEB_VERSION__: string;
export const webReleaseVersion = typeof __VOXLY_WEB_VERSION__ === "string" ? __VOXLY_WEB_VERSION__ : null;
export const ApplicationUpdateContext = createContext<{
  desktop: DesktopUpdateSnapshot | null;
  reviewDesktop: () => Promise<void>;
  pendingClient: string | null;
  clientBusy: boolean;
  reloadClient: () => void;
}>({ desktop: null, reviewDesktop: async () => {}, pendingClient: null, clientBusy: false, reloadClient: () => {} });
export function useApplicationUpdates() {
  return useContext(ApplicationUpdateContext);
}
