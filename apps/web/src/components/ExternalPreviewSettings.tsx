import { useId } from "react";
import type { Translate } from "../app/types.js";
import {
  externalPreviewProviders,
  type ExternalPreviewPreferences
} from "../lib/externalPreviewPreferences.js";
import type { MessageEmbedProvider } from "../lib/messageEmbeds.js";

const providerNames: Record<MessageEmbedProvider, string> = {
  youtube: "YouTube",
  x: "X / Twitter",
  vimeo: "Vimeo",
  spotify: "Spotify"
};

function PreviewSwitch({ provider, enabled, onChange }: {
  provider: MessageEmbedProvider;
  enabled: boolean;
  onChange(enabled: boolean): void;
}) {
  const labelId = useId();
  return (
    <div className="audio-toggle-control">
      <span id={labelId}>{providerNames[provider]}</span>
      <button
        className={`audio-switch ${enabled ? "is-on" : ""}`}
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-labelledby={labelId}
        onClick={() => onChange(!enabled)}
      ><span aria-hidden="true" /></button>
    </div>
  );
}

export function ExternalPreviewSettings({ preferences, t, onChange }: {
  preferences: ExternalPreviewPreferences;
  t: Translate;
  onChange(provider: MessageEmbedProvider, enabled: boolean): void;
}) {
  const allEnabled = externalPreviewProviders.every((provider) => preferences[provider]);
  const allDisabled = externalPreviewProviders.every((provider) => !preferences[provider]);
  const setAll = (enabled: boolean) => {
    for (const provider of externalPreviewProviders) onChange(provider, enabled);
  };

  return (
    <section className="theme-card privacy-preview-settings">
      <div className="theme-card-head"><span className="label">{t("privacy.externalPreviews")}</span></div>
      <p className="muted small">{t("privacy.externalPreviewsHint")}</p>
      <div className="message-actions privacy-preview-actions">
        <button className="btn btn-ghost" type="button" disabled={allEnabled} onClick={() => setAll(true)}>{t("privacy.enableAll")}</button>
        <button className="btn btn-ghost" type="button" disabled={allDisabled} onClick={() => setAll(false)}>{t("privacy.disableAll")}</button>
      </div>
      <div className="audio-device-fields">
        {externalPreviewProviders.map((provider) => (
          <PreviewSwitch
            key={provider}
            provider={provider}
            enabled={preferences[provider]}
            onChange={(enabled) => onChange(provider, enabled)}
          />
        ))}
      </div>
    </section>
  );
}
