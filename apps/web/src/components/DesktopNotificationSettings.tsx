import { useId, useState } from "react";
import type { Translate } from "../app/types.js";
import {
  desktopNotificationPermission, readDesktopNotifications,
  requestDesktopNotificationPermission, resetDesktopNotificationPermission, writeDesktopNotifications
} from "../lib/desktopNotifications.js";

export function DesktopNotificationSettings({ userId, t }: { userId: string; t: Translate }) {
  const labelId = useId();
  const [enabled, setEnabled] = useState(() => readDesktopNotifications(userId));
  const [permission, setPermission] = useState(() => desktopNotificationPermission(typeof window === "undefined" ? {} : window));
  const [pending, setPending] = useState(false);
  const [reset, setReset] = useState<"idle" | "done" | "failed">("idle");
  const [failed, setFailed] = useState(false);
  if (typeof window === "undefined" || window.__VOXLY_DESKTOP_V1__?.version !== 1) return null;

  const toggle = async () => {
    if (pending) return;
    setFailed(false);
    setReset("idle");
    if (enabled) {
      const saved = writeDesktopNotifications(userId, false);
      setFailed(!saved);
      if (saved) setEnabled(false);
      return;
    }
    setPending(true);
    try {
      const next = await requestDesktopNotificationPermission(window);
      setPermission(next);
      if (next === "granted") {
        const saved = writeDesktopNotifications(userId, true);
        setFailed(!saved);
        setEnabled(saved);
      }
    } finally { setPending(false); }
  };

  const recover = async () => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      const success = await resetDesktopNotificationPermission(window);
      setReset(success ? "done" : "failed");
      setPermission(desktopNotificationPermission(window));
    } finally { setPending(false); }
  };

  return <section className="theme-card">
    <div className="theme-card-head"><h3 className="label">{t("desktopNotifications.title")}</h3></div>
    <p className="muted small">{t("desktopNotifications.hint")}</p>
    <div className="audio-toggle-control">
      <span id={labelId}>{t("desktopNotifications.enable")}</span>
      <button type="button" role="switch" aria-checked={enabled && permission === "granted"}
        aria-labelledby={labelId} className={`audio-switch ${enabled && permission === "granted" ? "is-on" : ""}`}
        disabled={pending || (!enabled && permission === "unavailable")}
        onClick={() => { void toggle(); }}><span aria-hidden="true" /></button>
    </div>
    {permission === "denied" && window.__VOXLY_DESKTOP_NOTIFICATIONS_V1__?.version === 1 &&
      <button type="button" className="btn" disabled={pending} onClick={() => { void recover(); }}>{t("desktopNotifications.reset")}</button>}
    <p className="muted small" role="status">{t(reset === "done" ? "desktopNotifications.resetDone" : reset === "failed" ? "desktopNotifications.resetFailed" : failed ? "desktopNotifications.saveFailed"
      : permission === "denied" ? "desktopNotifications.denied"
      : permission === "unavailable" ? "desktopNotifications.unavailable"
      : enabled && permission === "granted" ? "desktopNotifications.on" : "desktopNotifications.off")}</p>
  </section>;
}
