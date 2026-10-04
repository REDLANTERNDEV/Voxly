import { downloadVoiceDiagnostics } from "../../lib/voiceDiagnostics.js";
import { useState } from "react";
import { activeServerRole,initial,voiceSignalPresentation } from "../../app/presentation.js";
import type { ShellActions,ShellModel,Translate } from "../../app/types.js";
import { ConfirmDialog } from "../../components/ui/Dialogs.js";
import { CameraIcon,GearIcon,HeadsetIcon,LeaveIcon,MicIcon,ScreenIcon,ShieldIcon } from "../../components/ui/Icons.js";
import { NavLink } from "../../components/ui/Navigation.js";
import { ControlButton } from "../../components/ui/Primitives.js";
import { type TranslationKey } from "../../lib/i18n.js";
import { ApplicationUpdateStatus } from "../ApplicationUpdateStatus.js";
import type { ConnectionHealth } from "../../lib/useConnectionHealth.js";
import type { VoiceQuality } from "../../lib/useVoiceQuality.js";
import { controlPresentation } from "../../lib/voiceControls.js";
type VoiceDockProps = Pick<ShellModel,
  "activeServerId" | "activeVoiceRoomId" | "connectionHealth" | "controls" |
  "currentNickname" | "currentRoom" | "microphoneTestActive" | "route" |
  "rooms" | "servers" | "socketState" | "t" | "user" | "voiceModeration" | "micLockedByRoom" |
  "voiceQuality" | "voiceSnapshots" | "microphoneHealthWarning"
> & Pick<ShellActions,
  "onJoinVoice" | "onLeaveVoice" | "onLogout" | "onNavigate" | "onToggleControl"
> & { connectedCount: number; onOpenSettings: () => void; onOpenAudioSettings?: () => void };

export function VoiceDock(props: VoiceDockProps) {
  const canManageServer = activeServerRole(props) === "owner";
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const roomName = props.activeVoiceRoomId
    ? props.rooms.voice.find((room) => room.id === props.activeVoiceRoomId)?.name ?? props.t("room.lobbyVoice")
    : props.t("common.offline");
  const canJoinCurrentVoice = !props.activeVoiceRoomId && props.route.name === "voice";
  const micControl = controlPresentation("mic", props.controls);
  const selfMedia = props.activeVoiceRoomId
    ? props.voiceSnapshots[props.activeVoiceRoomId]?.members.find((member) => member.user.userId === props.user.id)?.media
    : undefined;
  // Hold modes close publication without changing the button's manual-mute action.
  const micOn = props.controls.mic.on && (selfMedia?.mic ?? true);
  const deafenControl = controlPresentation("deafen", props.controls);
  const cameraControl = controlPresentation("camera", props.controls);
  const screenControl = controlPresentation("screenShare", props.controls);
  return (
    <footer className="voice-dock">
      <div className="dock-room">
        <div className="dock-connection">
        <ConnectionSignal health={props.connectionHealth} quality={props.voiceQuality} inCall={Boolean(props.activeVoiceRoomId)} t={props.t} />
        <span className="dock-status"><strong>{roomName}</strong></span>
        </div>
        {props.microphoneHealthWarning ? <span className="microphone-health-warning" role="status">
          <span>{props.t("audio.captureFault")}</span>
          <button className="btn btn-ghost" type="button" onClick={props.onOpenAudioSettings ?? props.onOpenSettings}>{props.t("audio.openSettings")}</button>
        </span> : null}
        <ApplicationUpdateStatus t={props.t} />
      </div>
      <div className="dock-controls">
        {canJoinCurrentVoice ? (
          <button className="btn btn-primary" type="button" disabled={props.socketState !== "live"} onClick={() => props.onJoinVoice(props.currentRoom?.id ?? "lobby")}><HeadsetIcon off={false} /><span>{props.t("room.joinCurrentVoice")}</span></button>
        ) : null}
        {props.activeVoiceRoomId ? (
          <>
            {props.micLockedByRoom
              ? <ControlButton label={props.t("room.afkMuted")} active tone="danger" enabled={false} onClick={() => undefined}><MicIcon off /></ControlButton>
              : props.voiceModeration.muted
              ? <ControlButton label={props.t("member.ownerMuted")} active tone="danger" enabled={false} onClick={() => undefined}><MicIcon off /></ControlButton>
              : <ControlButton label={props.t(`common.${micControl.action}` as TranslationKey)} active={props.controls.mic.on} silenced={!micOn} tone={micControl.tone} enabled={props.controls.mic.enabled && props.socketState === "live"} onClick={() => props.onToggleControl("mic")}><MicIcon off={!micOn} /></ControlButton>}
            {props.voiceModeration.deafened
              ? <ControlButton label={props.t("member.ownerDeafened")} active tone="danger" enabled={false} onClick={() => undefined}><HeadsetIcon off /></ControlButton>
              : <ControlButton label={props.t(`common.${deafenControl.action}` as TranslationKey)} active={props.controls.deafen.on} silenced={props.controls.deafen.on} tone={deafenControl.tone} enabled={props.controls.deafen.enabled && !props.microphoneTestActive && props.socketState === "live"} onClick={() => props.onToggleControl("deafen")}><HeadsetIcon off={props.controls.deafen.on} /></ControlButton>}
            <ControlButton label={props.t(`common.${cameraControl.action}` as TranslationKey)} active={props.controls.camera.on} tone={cameraControl.tone} enabled={props.controls.camera.enabled && props.socketState === "live"} onClick={() => props.onToggleControl("camera")}><CameraIcon off={!props.controls.camera.on} /></ControlButton>
            <ControlButton label={props.t(`common.${screenControl.action}` as TranslationKey)} active={props.controls.screenShare.on} tone={screenControl.tone} enabled={props.controls.screenShare.enabled && props.socketState === "live"} onClick={() => props.onToggleControl("screenShare")}><ScreenIcon off={props.controls.screenShare.on} /></ControlButton>
            <button className="btn btn-danger dock-leave" type="button" aria-label={props.t("common.leave")} title={props.t("common.leave")} onClick={props.onLeaveVoice}><LeaveIcon /><span>{props.t("common.leave")}</span></button>
          </>
        ) : null}
      </div>
      <div className="dock-self">
        <details className="account-menu">
          <summary aria-label={props.t("shell.accountMenu", { nickname: props.currentNickname })}>
            <span className={`avatar ${props.user.role === "owner" ? "owner" : ""}`} title={props.currentNickname}>{initial(props.currentNickname)}</span>
          </summary>
          <div className="account-menu-panel">
            <strong>{props.currentNickname}</strong>
            <ApplicationUpdateStatus t={props.t} surface="account" onSelect={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); }} />
            <button className="btn btn-ghost account-settings-link" type="button" onClick={(event) => { event.currentTarget.closest("details")?.removeAttribute("open"); props.onOpenSettings(); }}><GearIcon /><span>{props.t("settings.open")}</span></button>
            {canManageServer ? <NavLink className="btn btn-ghost account-owner-link" href={`/app/server/${encodeURIComponent(props.activeServerId)}/owner`} label={props.t("owner.panel")} onNavigate={props.onNavigate}><ShieldIcon /><span>{props.t("owner.panel")}</span></NavLink> : null}
            <button className="btn btn-danger" type="button" onClick={() => setConfirmingLogout(true)}>{props.t("common.logout")}</button>
          </div>
        </details>
      </div>
      {confirmingLogout ? <ConfirmDialog cancelLabel={props.t("common.cancel")} title={props.t("auth.signOutTitle")} copy={props.t("auth.signOutCopy")} confirmLabel={props.t("common.logout")} onCancel={() => setConfirmingLogout(false)} onConfirm={() => { setConfirmingLogout(false); void props.onLogout(); }} /> : null}
    </footer>
  );
}

export function ConnectionSignal({ health, quality, inCall, t }: {
  health: ConnectionHealth;
  quality: VoiceQuality;
  inCall: boolean;
  t: Translate;
}) {
  const [savingReport, setSavingReport] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const { tone, value, label } = voiceSignalPresentation(health, quality, inCall, t);
  return (
    <span className={`connection-signal is-${tone}`} role="status" aria-label={label} title={label}>
      <svg viewBox="0 0 20 16" aria-hidden="true">
        <rect x="1" y="11" width="3" height="4" rx="1" />
        <rect x="6" y="8" width="3" height="7" rx="1" />
        <rect x="11" y="4" width="3" height="11" rx="1" />
        <rect x="16" y="1" width="3" height="14" rx="1" />
      </svg>
      <span>{value}</span>
      {inCall && <button type="button" className="voice-diagnostics-download" disabled={savingReport} onClick={() => {
        setSavingReport(true); setSaveError(false);
        void downloadVoiceDiagnostics().catch(() => setSaveError(true)).finally(() => setSavingReport(false));
      }} title={t("voiceQuality.downloadDiagnostics")} aria-label={t("voiceQuality.downloadDiagnostics")}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v10m-4-4 4 4 4-4M3 13v4h14v-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      </button>}
      {saveError ? <span className="microphone-health-warning" role="alert">{t("voiceQuality.saveFailed")}</span> : null}
    </span>
  );
}

export function ReconnectOverlay({ health, t }: { health: ConnectionHealth; t: Translate }) {
  const copy = health.reason === "browser_offline"
    ? t("connection.browserOffline")
    : health.reconnectAttempt > 0
      ? t("connection.reconnectingCopy")
      : t("connection.serverUnreachable");
  return (
    <div className="reconnect-overlay" role="status" aria-live="assertive">
      <div className="reconnect-panel">
        <div className="reconnect-indicator" aria-hidden="true">
          <span className="reconnect-spinner" />
          <svg className="reconnect-logo" viewBox="0 0 512 512" width="48" height="48">
            <defs>
              <linearGradient id="reconnect-logo-gradient" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0%" stopColor="#7E8996" />
                <stop offset="52%" stopColor="#BFC7D1" />
                <stop offset="100%" stopColor="#FFFFFF" />
              </linearGradient>
            </defs>
            <path d="M 110 125 L 235 360 L 335 245" fill="none" stroke="url(#reconnect-logo-gradient)" strokeWidth="94" strokeLinecap="round" strokeLinejoin="round" />
            <g fill="url(#reconnect-logo-gradient)" shapeRendering="geometricPrecision">
              <rect x="282" y="116" width="26" height="56" rx="13" />
              <rect x="322" y="98" width="26" height="92" rx="13" />
              <rect x="362" y="80" width="26" height="128" rx="13" />
              <rect x="402" y="98" width="26" height="92" rx="13" />
              <rect x="442" y="116" width="26" height="56" rx="13" />
            </g>
          </svg>
        </div>
        <strong>{t("connection.reconnecting")}</strong>
        <span>{copy}</span>
      </div>
    </div>
  );
}
