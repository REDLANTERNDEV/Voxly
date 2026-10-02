import type { Translate } from "../app/types.js";
import { MAX_NOTIFICATION_VOLUME_PERCENT, type NotificationSoundPreferences } from "../lib/notificationSounds.js";
import { AudioLevelControl, AudioSwitchControl } from "./AudioControls.js";

interface SoundLabels {
  notificationSounds: string;
  notificationSoundsHint: string;
  notificationVolume: string;
  notificationVoice: string;
  notificationMessage: string;
  notificationConnection: string;
}
export function NotificationSoundControls({ preferences, labels, onChange }: {
  preferences: NotificationSoundPreferences; labels: SoundLabels; onChange: (patch: Partial<NotificationSoundPreferences>) => void;
}) {
  return <div className="notification-sound-section">
    <AudioSwitchControl label={labels.notificationSounds} hint={labels.notificationSoundsHint} checked={preferences.enabled} onChange={(enabled) => onChange({ enabled })} />
    {preferences.enabled ? <>
      <AudioLevelControl label={labels.notificationVolume} value={preferences.volume} max={MAX_NOTIFICATION_VOLUME_PERCENT} onChange={(volume) => onChange({ volume })} />
      <AudioSwitchControl label={labels.notificationVoice} checked={preferences.voice} onChange={(voice) => onChange({ voice })} />
      <AudioSwitchControl label={labels.notificationMessage} checked={preferences.message} onChange={(message) => onChange({ message })} />
      <AudioSwitchControl label={labels.notificationConnection} checked={preferences.connection} onChange={(connection) => onChange({ connection })} />
    </> : null}
  </div>;
}
export function NotificationSoundSettings({ t, preferences, onChange }: {
  t: Translate; preferences: NotificationSoundPreferences; onChange: (patch: Partial<NotificationSoundPreferences>) => void;
}) {
  return <section className="theme-card notification-settings-card">
    <h3 className="label">{t("audio.notificationSounds")}</h3>
    <NotificationSoundControls preferences={preferences} onChange={onChange} labels={{
      notificationSounds: t("audio.notificationSounds"), notificationSoundsHint: t("audio.notificationSoundsHint"),
      notificationVolume: t("audio.notificationVolume"), notificationVoice: t("audio.notificationVoice"),
      notificationMessage: t("audio.notificationMessage"), notificationConnection: t("audio.notificationConnection")
    }} />
  </section>;
}
