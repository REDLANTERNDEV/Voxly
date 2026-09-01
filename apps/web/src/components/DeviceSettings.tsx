import type { DeviceSummary } from "@voxly/shared";
import { useCallback, useEffect, useState } from "react";
import type { Translate } from "../app/types.js";
import { fetchDevices, signOutDevice } from "../api.js";
import { LinkDeviceDialog } from "../features/auth/LinkDeviceDialog.js";
import { ConfirmDialog } from "./ui/Dialogs.js";
import { LeaveIcon } from "./ui/Icons.js";

/**
 * What is signed in as you, and how you close one.
 *
 * This is the detection half of ADR-0014. Linking a second Device is only safe
 * if a member can afterwards look at the list and answer "was that me?" — and
 * an account nobody can inspect is one nobody can defend. So the list is not a
 * convenience that came with linking; it is the thing linking depends on.
 *
 * Loaded on demand rather than with the shell. A member opens this rarely, and
 * a list of sessions is not worth a request on every start.
 */
export function DeviceSettings({ t }: { t: Translate }) {
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [linking, setLinking] = useState(false);
  // Signing a Device out cannot be undone from here — that Device has to link
  // again — so a mis-click deserves a question rather than a consequence.
  const [confirming, setConfirming] = useState<DeviceSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetchDevices();
      setDevices(response.devices);
      setError("");
    } catch {
      setError(t("devices.loadFailed"));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const signOut = useCallback(async (deviceId: string) => {
    setBusyId(deviceId);
    try {
      await signOutDevice(deviceId);
      // Re-read rather than splicing the row out locally: the answer to "what
      // is signed in as me" has to come from the server, or a failed
      // revocation would leave a Device the member believes is gone.
      await load();
    } catch {
      setError(t("devices.signOutFailed"));
    } finally {
      setBusyId("");
    }
  }, [load, t]);

  return (
    <section className="theme-card device-card">
      <div className="theme-card-head"><span className="label">{t("devices.title")}</span></div>
      <p className="muted small">{t("devices.hint")}</p>
      {error ? <p className="small device-error" role="alert">{error}</p> : null}
      {devices === null && !error ? <p className="muted small">{t("devices.loading")}</p> : null}
      <button className="btn btn-ghost device-link-action" type="button" onClick={() => setLinking(true)}>
        {t("devices.linkDevice")}
      </button>
      {/* Re-reading on close is what makes a Device the member just linked
          appear without them having to go looking for it. */}
      {linking ? <LinkDeviceDialog t={t} onClose={() => { setLinking(false); void load(); }} /> : null}
      <ul className="device-list">
        {(devices ?? []).map((device) => (
          <li className="device-row" key={device.id}>
            <span className="device-identity">
              <strong>{device.label}</strong>
              <span className="muted small">
                {device.current
                  ? t("devices.thisDevice")
                  : t("devices.lastUsed", { when: relativeDay(device.lastSeenAt ?? device.createdAt, t) })}
              </span>
              {/* How it arrived, because "was that me?" is much easier to answer
                  when the list says which. A Device that appeared by Recovery is
                  a very different event from one linked while holding both. */}
              {device.origin === "invite" ? null : (
                <span className={`device-origin ${device.origin === "recovery" ? "is-recovery" : ""}`}>
                  {t(device.origin === "recovery" ? "devices.arrivedByRecovery" : "devices.arrivedByLink")}
                </span>
              )}
            </span>
            {device.current ? null : (
              <button
                className="btn btn-danger device-sign-out"
                type="button"
                disabled={busyId === device.id}
                onClick={() => setConfirming(device)}
              >
                <LeaveIcon />
                <span>{t("devices.signOut")}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {confirming ? (
        <ConfirmDialog
          title={t("devices.signOutTitle")}
          copy={t("devices.signOutCopy", { device: confirming.label })}
          confirmLabel={t("devices.signOut")}
          cancelLabel={t("common.cancel")}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const target = confirming.id;
            setConfirming(null);
            void signOut(target);
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Coarse on purpose, to match the label beside it. A member is deciding whether
 * a Device is theirs, and "3 days ago" settles that as well as a timestamp
 * would while being readable at a glance in both languages.
 */
export function relativeDay(iso: string, t: Translate) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return t("devices.whenUnknown");
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return t("devices.today");
  if (days === 1) return t("devices.yesterday");
  return t("devices.daysAgo", { count: days });
}
