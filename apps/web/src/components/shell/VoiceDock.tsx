import { useState } from "react";
import { activeServerRole,connectionCopy,connectionLabel,initial,voiceDockStatusLabel } from "../../app/presentation.js";
import type { ShellActions,ShellModel,Translate } from "../../app/types.js";
import { ConfirmDialog } from "../../components/ui/Dialogs.js";
import { CameraIcon,HeadsetIcon,LeaveIcon,MicIcon,ScreenIcon,ShieldIcon } from "../../components/ui/Icons.js";
import { NavLink } from "../../components/ui/Navigation.js";
import { ControlButton } from "../../components/ui/Primitives.js";
import { type TranslationKey } from "../../lib/i18n.js";
import type { ConnectionHealth } from "../../lib/useConnectionHealth.js";
import { controlPresentation } from "../../lib/voiceControls.js";
type VoiceDockProps = Pick<ShellModel,
  "activeServerId" | "activeVoiceRoomId" | "connectionHealth" | "controls" |
  "currentNickname" | "currentRoom" | "microphoneTestActive" | "route" |
  "servers" | "socketState" | "t" | "user" | "voiceModeration" | "micLockedByRoom"
> & Pick<ShellActions,
  "onJoinVoice" | "onLeaveVoice" | "onLogout" | "onNavigate" | "onToggleControl"
> & { connectedCount: number };

export function VoiceDock(props: VoiceDockProps) {
  const canManageServer = activeServerRole(props) === "owner";
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const roomName = props.activeVoiceRoomId ? props.t("room.lobbyVoice") : props.t("common.offline");
  const canJoinCurrentVoice = !props.activeVoiceRoomId && props.route.name === "voice";
  const micControl = controlPresentation("mic", props.controls);
  const deafenControl = controlPresentation("deafen", props.controls);
  const cameraControl = controlPresentation("camera", props.controls);
  const screenControl = controlPresentation("screenShare", props.controls);
  return (
    <footer className="voice-dock">
      <div className="dock-room">
        <ConnectionSignal health={props.connectionHealth} t={props.t} />
        <span className="dock-status"><strong>{roomName}</strong><span className="muted small">{props.activeVoiceRoomId ? `${voiceDockStatusLabel(props.controls, props.connectedCount, props.t)} · ${connectionLabel(props.socketState, props.t)}` : connectionCopy(props.socketState, props.t)}</span></span>
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
              : <ControlButton label={props.t(`common.${micControl.action}` as TranslationKey)} active={props.controls.mic.on} tone={micControl.tone} enabled={props.controls.mic.enabled && props.socketState === "live"} onClick={() => props.onToggleControl("mic")}><MicIcon off={!props.controls.mic.on} /></ControlButton>}
            {props.voiceModeration.deafened
              ? <ControlButton label={props.t("member.ownerDeafened")} active tone="danger" enabled={false} onClick={() => undefined}><HeadsetIcon off /></ControlButton>
              : <ControlButton label={props.t(`common.${deafenControl.action}` as TranslationKey)} active={props.controls.deafen.on} tone={deafenControl.tone} enabled={props.controls.deafen.enabled && !props.microphoneTestActive && props.socketState === "live"} onClick={() => props.onToggleControl("deafen")}><HeadsetIcon off={props.controls.deafen.on} /></ControlButton>}
            <ControlButton label={props.t(`common.${cameraControl.action}` as TranslationKey)} active={props.controls.camera.on} tone={cameraControl.tone} enabled={props.controls.camera.enabled && props.socketState === "live"} onClick={() => props.onToggleControl("camera")}><CameraIcon off={!props.controls.camera.on} /></ControlButton>
            <ControlButton label={props.t(`common.${screenControl.action}` as TranslationKey)} active={props.controls.screenShare.on} tone={screenControl.tone} enabled={props.controls.screenShare.enabled && props.socketState === "live"} onClick={() => props.onToggleControl("screenShare")}><ScreenIcon off={props.controls.screenShare.on} /></ControlButton>
            <button className="btn btn-danger" type="button" onClick={props.onLeaveVoice}><LeaveIcon /><span>{props.t("common.leave")}</span></button>
          </>
        ) : null}
      </div>
      <div className="dock-self">
        {canManageServer ? (
          <NavLink className="btn btn-ghost" href={`/app/server/${encodeURIComponent(props.activeServerId)}/owner`} onNavigate={props.onNavigate}><ShieldIcon /><span>{props.t("owner.panel")}</span></NavLink>
        ) : null}
        <details className="account-menu">
          <summary aria-label={`${props.currentNickname} account menu`}>
            <span className={`avatar ${props.user.role === "owner" ? "owner" : ""}`} title={props.currentNickname}>{initial(props.currentNickname)}</span>
          </summary>
          <div className="account-menu-panel">
            <strong>{props.currentNickname}</strong>
            <button className="btn btn-danger" type="button" onClick={() => setConfirmingLogout(true)}>{props.t("common.logout")}</button>
          </div>
        </details>
      </div>
      {confirmingLogout ? <ConfirmDialog cancelLabel={props.t("common.cancel")} title={props.t("auth.signOutTitle")} copy={props.t("auth.signOutCopy")} confirmLabel={props.t("common.logout")} onCancel={() => setConfirmingLogout(false)} onConfirm={() => { setConfirmingLogout(false); void props.onLogout(); }} /> : null}
    </footer>
  );
}

export function ConnectionSignal({ health, t }: { health: ConnectionHealth; t: Translate }) {
  const tone = health.quality === "good" ? "good" : health.quality === "fair" || health.quality === "measuring" ? "fair" : "poor";
  const label = health.rttMs === null ? t("connection.measuring") : t("connection.latency", { value: Math.round(health.rttMs) });
  return (
    <span className={`connection-signal is-${tone}`} role="status" aria-label={label}>
      <svg viewBox="0 0 20 16" aria-hidden="true">
        <rect x="1" y="11" width="3" height="4" rx="1" />
        <rect x="6" y="8" width="3" height="7" rx="1" />
        <rect x="11" y="4" width="3" height="11" rx="1" />
        <rect x="16" y="1" width="3" height="14" rx="1" />
      </svg>
      <span>{health.rttMs === null ? "-- ms" : `${Math.round(health.rttMs)} ms`}</span>
    </span>
  );
}

export function ReconnectOverlay({ health, t }: { health: ConnectionHealth; t: Translate }) {
  const copy = health.reason === "browser_offline"
    ? t("connection.browserOffline")
    : health.reconnectAttempt > 0
      ? t("connection.retryAttempt", { count: health.reconnectAttempt })
      : t("connection.serverUnreachable");
  return (
    <div className="reconnect-overlay" role="status" aria-live="assertive">
      <img className="reconnect-logo" src="/brand/logo-mark.svg" alt="" width="72" height="72" />
      <strong>{t("connection.reconnecting")}</strong>
      <span>{copy}</span>
    </div>
  );
}
