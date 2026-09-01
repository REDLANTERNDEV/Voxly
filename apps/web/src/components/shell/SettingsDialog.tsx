import { useEffect, useRef, useState } from "react";
import type { ShellActions, ShellModel } from "../../app/types.js";
import { AudioDeviceSettings } from "../AudioDeviceSettings.js";
import { DeviceSettings } from "../DeviceSettings.js";
import { RecoverySettings } from "../RecoverySettings.js";
import { PreferencesCard } from "../ui/Primitives.js";

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

type SettingsSection = "account" | "audio" | "appearance";

const sections: readonly SettingsSection[] = ["account", "audio", "appearance"];

export function SettingsDialog(props: ShellModel & ShellActions & { onClose: () => void }) {
  const [section, setSection] = useState<SettingsSection>("account");
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.onClose]);

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={props.onClose}>
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.t("settings.title")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <nav className="settings-nav" aria-label={props.t("settings.title")}>
          <span className="label settings-nav-label">{props.t("settings.title")}</span>
          {sections.map((item) => (
            <button
              className="settings-nav-item"
              type="button"
              key={item}
              aria-current={section === item}
              onClick={() => setSection(item)}
            >
              {props.t(`settings.${item}`)}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <button className="settings-close btn btn-ghost" type="button" ref={closeRef} onClick={props.onClose}>
            {props.t("common.close")}
          </button>
          <div className="settings-content">
            {section === "account" ? (
              <>
                <DeviceSettings t={props.t} />
                <RecoverySettings t={props.t} />
              </>
            ) : null}
            {section === "audio" ? (
              <AudioDeviceSettings
                inline
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
                loading={props.audioDevices.loading}
                error={props.audioDevices.error ? props.t(props.audioDevices.error) : ""}
                unavailableSelections={props.audioDevices.unavailableSelections}
                outputSelectionSupported={props.audioDevices.outputSelectionSupported}
                labels={{
                  title: props.t("audio.title"),
                  microphone: props.t("audio.microphone"),
                  output: props.t("audio.output"),
                  systemDefault: props.t("audio.systemDefault"),
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
            ) : null}
            {section === "appearance" ? (
              <PreferencesCard
                language={props.language}
                theme={props.theme}
                t={props.t}
                onLanguageChange={props.onLanguageChange}
                onThemeChange={props.onThemeChange}
              />
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
