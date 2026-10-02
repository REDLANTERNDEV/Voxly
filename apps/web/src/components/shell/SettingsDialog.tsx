import { useEffect, useRef, useState } from "react";
import type { ShellActions, ShellModel } from "../../app/types.js";
import { AudioDeviceSettings } from "../AudioDeviceSettings.js";
import { DeviceSettings } from "../DeviceSettings.js";
import { RecoverySettings } from "../RecoverySettings.js";
import { PreferencesCard } from "../ui/Primitives.js";
import { GearIcon, HeadsetIcon, ShieldIcon, UsersIcon, KeyboardIcon, BellIcon, CloseIcon } from "../ui/Icons.js";
import type { TranslationKey } from "../../lib/i18n.js";
import { ExternalPreviewSettings } from "../ExternalPreviewSettings.js";
import { AccountDeletionSettings } from "../AccountDeletionSettings.js";
import { DesktopNotificationSettings } from "../DesktopNotificationSettings.js";
import { DesktopHomeButton, DesktopMicrophoneSettings, DesktopShortcutSettings } from "../DesktopSettings.js";
import { desktopSettingsAvailable } from "../../lib/desktopSettings.js";
import { NotificationSoundSettings } from "../NotificationSoundSettings.js";
import { webReleaseVersion } from "../../lib/applicationUpdates.js";
import { ApplicationVersionSettings } from "../ApplicationUpdateStatus.js";

/**
 * Settings, in a window over the room rather than stacked down the channel rail.
 *
 * The rail is a navigation surface — servers, channels, who is in them — and
 * every setting parked there pushed the channels further up and out of sight.
 * Four cards of preferences below the channel list is a list nobody scrolls,
 * next to a list everybody uses.
 *
 * So they move into one dialog with its own sections, which is what a member
 * expects from every other application of this shape. It also gives settings
 * room: the Devices list and the audio controls are both bigger than a
 * 260-pixel column ever wanted to be.
 */

export type SettingsSection = "account" | "audio" | "appearance" | "privacy" | "shortcuts" | "notifications" | "about";

const sections: readonly SettingsSection[] = ["account", "audio", "notifications", "appearance", "privacy"];
const sectionIcons = {
  shortcuts: <KeyboardIcon />,
  notifications: <BellIcon />,
  about: <GearIcon />,
  account: <UsersIcon />,
  audio: <HeadsetIcon off={false} />,
  appearance: <GearIcon />,
  privacy: <ShieldIcon />
} as const;

export function SettingsDialog(props: ShellModel & ShellActions & { initialSection?: SettingsSection; contextError?: TranslationKey | ""; onClose: () => void }) {
  const [section, setSection] = useState<SettingsSection>(props.initialSection ?? "account");
  const desktop = typeof window !== "undefined" && desktopSettingsAvailable(window);
  const visibleSections = desktop ? [...sections, "shortcuts"] as SettingsSection[] : sections;
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector("dialog[open]")) props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); if (returnFocus?.isConnected) returnFocus.focus(); };
  }, [props.onClose]);

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={props.onClose}>
      <section
        className={`settings-dialog settings-${section}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.t("settings.title")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <nav className="settings-nav" aria-label={props.t("settings.title")}>
          <span className="label settings-nav-label">{props.t("settings.title")}</span>
          {visibleSections.map((item) => (
            <button
              className="settings-nav-item"
              type="button"
              key={item}
              aria-current={section === item}
              onClick={() => setSection(item)}
            >
              <span className="settings-nav-icon" aria-hidden="true">{sectionIcons[item]}</span>
              <span>{props.t(`settings.${item}`)}</span>
            </button>
          ))}
          <div className="settings-nav-footer">
            {desktop ? <DesktopHomeButton t={props.t} onOpened={props.onClose} /> : null}
            <button className="settings-version-link" type="button" aria-current={section === "about"} aria-label={`${props.t("settings.webVersion")}: ${webReleaseVersion ? `v${webReleaseVersion}` : "—"}`} onClick={() => setSection("about")}>
              {props.t("settings.interface")} {webReleaseVersion ? `v${webReleaseVersion}` : "—"}
            </button>
          </div>
        </nav>
        <div className="settings-body">
          <header className="settings-section-header">
            <div><span className="label">{props.t("settings.title")}</span><h2>{props.t(`settings.${section}`)}</h2></div>
            <button className="settings-close icon-btn" type="button" title={props.t("common.close")} aria-label={props.t("common.close")} ref={closeRef} onClick={props.onClose}>
              <CloseIcon />
            </button>
          </header>
          <div className="settings-content">
            {section === "shortcuts" && desktop ? <DesktopShortcutSettings t={props.t} onAudio={() => setSection("audio")} /> : null}
            {section === "about" ? <ApplicationVersionSettings t={props.t} /> : null}
            {section === "account" ? (
              <>
                <DeviceSettings t={props.t} />
                <RecoverySettings t={props.t} />
                {props.user.role !== "owner" ? <AccountDeletionSettings nickname={props.user.nickname} t={props.t} /> : null}
              </>
            ) : null}
            {section === "audio" ? (
              <>
              <AudioDeviceSettings
                inline
                showNotificationSounds={false}
                microphoneControls={desktop ? <DesktopMicrophoneSettings t={props.t} onShortcuts={() => setSection("shortcuts")} /> : null}
                inputs={props.audioDevices.inputs}
                outputs={props.audioDevices.outputs}
                selectedInputId={props.audioDevices.selectedInputId}
                selectedOutputId={props.audioDevices.selectedOutputId}
                inputVolume={props.audioLevels.input}
                outputVolume={props.audioLevels.output}
                noiseSuppression={props.noiseSuppression}
                noiseSuppressionSupported={props.noiseSuppressionSupported}
                notificationSounds={props.notificationSounds}
                microphoneTestActive={props.microphoneTestActive}
                microphoneTestError={props.microphoneTestError}
                microphoneTestErrorOccurrences={props.microphoneTestErrorOccurrences}
                microphoneTestErrorRevision={props.microphoneTestErrorRevision}
                loading={props.audioDevices.loading}
                error={props.audioDevices.error ? props.t(props.audioDevices.error) : ""}
                errorOccurrences={props.audioDevices.errorOccurrences}
                errorRevision={props.audioDevices.errorRevision}
                contextError={props.contextError ? props.t(props.contextError) : ""}
                unavailableSelections={props.audioDevices.unavailableSelections}
                outputSelectionSupported={props.audioDevices.outputSelectionSupported}
                labels={{
                  title: props.t("audio.title"),
                  microphone: props.t("audio.microphone"),
                  output: props.t("audio.output"),
                  systemDefault: props.t("audio.systemDefault"),
                  inputUnavailable: props.t("audio.inputUnavailable"),
                  browserControlled: props.t("audio.browserControlled"),
                  refresh: props.t("audio.refresh"),
                  unavailable: props.t("audio.unavailable"),
                  inputVolume: props.t("audio.inputVolume"),
                  outputVolume: props.t("audio.outputVolume"),
                  noiseSuppression: props.t("audio.noiseSuppression"),
                  noiseSuppressionHint: props.t("audio.noiseSuppressionHint"),
                  noiseSuppressionUnsupported: props.t("audio.noiseSuppressionUnsupported"),
                  notificationSounds: props.t("audio.notificationSounds"),
                  notificationSoundsHint: props.t("audio.notificationSoundsHint"),
                  notificationVolume: props.t("audio.notificationVolume"),
                  notificationVoice: props.t("audio.notificationVoice"),
                  notificationMessage: props.t("audio.notificationMessage"),
                  notificationConnection: props.t("audio.notificationConnection"),
                  startTest: props.t("audio.startTest"),
                  stopTest: props.t("audio.stopTest"),
                  testHint: props.t("audio.testHint"),
                  testPermission: props.t("audio.testPermission"),
                  testUnavailable: props.t("audio.testUnavailable"),
                  microphoneTestErrorTitle: props.t("audio.microphoneTestErrorTitle"),
                  errorTitle: props.t("notification.settingsErrorTitle"),
                  dismissError: props.t("notification.dismiss"),
                  occurrences: (count) => props.t("notification.occurrences", { count }),
                  closeSettings: props.t("audio.closeSettings")
                }}
                onOpen={() => props.audioDevices.refresh(true)}
                onClose={props.onCloseAudioSettings}
                onRefresh={() => props.audioDevices.refresh(true)}
                onSelectInput={props.audioDevices.selectInput}
                onSelectOutput={props.audioDevices.selectOutput}
                onInputVolumeChange={props.onInputVolumeChange}
                onOutputVolumeChange={props.onOutputVolumeChange}
                onNoiseSuppressionChange={props.onNoiseSuppressionChange}
                onNotificationSoundsChange={props.onNotificationSoundsChange}
                onToggleMicrophoneTest={props.onToggleMicrophoneTest}
              />

              </>
            ) : null}
            {section === "notifications" ? <>
              <NotificationSoundSettings t={props.t} preferences={props.notificationSounds} onChange={props.onNotificationSoundsChange} />
              {desktop ? <DesktopNotificationSettings key={props.user.id} userId={props.user.id} t={props.t} /> : null}
            </> : null}
            {section === "appearance" ? (
              <PreferencesCard
                language={props.language}
                theme={props.theme}
                timeFormat={props.timeFormat}
                t={props.t}
                onLanguageChange={props.onLanguageChange}
                onThemeChange={props.onThemeChange}
                onTimeFormatChange={props.onTimeFormatChange}
              />
            ) : null}
            {section === "privacy" ? (
              <ExternalPreviewSettings
                preferences={props.externalPreviews}
                t={props.t}
                onChange={props.onExternalPreviewChange}
              />
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
