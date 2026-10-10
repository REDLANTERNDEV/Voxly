import { desktopSettingsAvailable, type DesktopSettingsBridge } from "./desktopSettings.js";
import type { ActivationBridge } from "./desktopNotifications.js";

interface DesktopApprovalRuntime {
  __VOXLY_DESKTOP_ACTIVATION_V1__?: ActivationBridge;
  __VOXLY_DESKTOP_SETTINGS_V1__?: DesktopSettingsBridge;
}

/** Yield to browser approval once, then restore only this still-current attempt. */
export function createDesktopApprovalWindow(target: DesktopApprovalRuntime, isCurrent: () => boolean) {
  const bridge = target.__VOXLY_DESKTOP_ACTIVATION_V1__;
  let minimizing: Promise<boolean> | null = null;
  let restoring: Promise<void> | null = null;
  return {
    minimize(): Promise<boolean> {
      if (minimizing) return minimizing;
      if (restoring || !isCurrent() || bridge?.version !== 1 || typeof bridge.minimize !== "function")
        return Promise.resolve(false);
      minimizing = (async () => {
        try {
          // Finish initial window reveal before minimizing a cold browser launch.
          if (desktopSettingsAvailable(target)) await target.__VOXLY_DESKTOP_SETTINGS_V1__!.apply({ kind: "ready" });
          if (!isCurrent() || restoring) return false;
          return await bridge.minimize!();
        } catch {
          return false;
        }
      })();
      return minimizing;
    },
    restore(): Promise<void> {
      if (restoring) return restoring;
      restoring = (async () => {
        if (!minimizing || !(await minimizing) || !isCurrent()) return;
        try {
          await bridge?.show();
        } catch {
          /* Native focus failure must not undo browser-approved sign-in. */
        }
      })();
      return restoring;
    }
  };
}
