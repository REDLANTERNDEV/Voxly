import { stageClickAction } from "./stageTileSelection.js";
import { StreamActions } from "./StreamActions.js";
import type { VisualMediaKind, VisualTarget, VoiceMediaState, VoiceModerationState } from "@voxly/shared";
import { useEffect, useId, useRef, useState } from "react";
import { voiceStatusItems } from "../../app/presentation.js";
import type { Translate } from "../../app/types.js";
import { MaximizeIcon, VolumeIcon } from "../../components/ui/Icons.js";
import { VolumeControl } from "../../components/ui/Primitives.js";
import { combineOutputVolume } from "../../lib/audioLevels.js";
import { connectAudioOutput, retryBlockedAudioOutputs, type AudioOutput } from "../../lib/audioOutput.js";
import { remoteStreamKey, type RemoteStreamState } from "../../lib/voiceStreams.js";
import { DEFAULT_VOLUME_PERCENT } from "../../lib/voiceVolume.js";
export interface StageSource {
  key: string;
  kind: VisualMediaKind;
  ownerId: string;
  ownerName: string;
  ownerIsLocal: boolean;
  stream: MediaStream | null;
  target: VisualTarget | null;
  connectionWarning?: boolean;
  connectionStatus: "connecting" | "reconnecting" | "failed" | "ready";
  onPlaybackReady?: (track: MediaStreamTrack) => void;
  onRetry?: () => void;
}
/**
 * What is true of a participant right now, at the end of their row.
 *
 * Marks, not labelled pills. The pills sat under the nickname, which cost the
 * row a second line the moment anyone muted themselves, right-aligned their
 * words under a left-aligned name, and wrapped once two of them were true. The
 * left rail already says these same facts with these same marks, so the stage
 * says them the same way; the label it dropped survives as the accessible name
 * and the tooltip, and the colour keeps the one distinction that matters —
 * red is an owner's doing, grey is your own.
 */
export function VoiceStatusBadges({
  media,
  moderation,
  t,
  showVisual = true
}: {
  media: VoiceMediaState | undefined;
  moderation?: VoiceModerationState;
  t: Translate;
  showVisual?: boolean;
}) {
  const items = voiceStatusItems(
    media && !showVisual ? { ...media, screen: false, camera: false } : media,
    moderation,
    t
  );
  if (items.length === 0) {
    return null;
  }

  return (
    <span className="voice-status-list">
      {items.map((item) => (
        <span
          className={`voice-status-icon is-${item.tone}`}
          key={item.label}
          role="img"
          aria-label={item.label}
          title={item.label}
        >
          {item.icon}
        </span>
      ))}
    </span>
  );
}

export function RemoteVideo({
  stream,
  muted = false,
  onPlaybackReady
}: {
  stream: MediaStream;
  muted?: boolean;
  onPlaybackReady?: (track: MediaStreamTrack) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readyRef = useRef(onPlaybackReady);
  readyRef.current = onPlaybackReady;
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const ready = () => {
      const track = stream.getVideoTracks()[0];
      if (video.srcObject === stream && video.readyState >= 2 && video.videoWidth > 0 && track)
        readyRef.current?.(track);
    };
    video.addEventListener("loadeddata", ready);
    video.addEventListener("playing", ready);
    video.srcObject = stream;
    return () => {
      video.removeEventListener("loadeddata", ready);
      video.removeEventListener("playing", ready);
    };
  }, [stream]);
  return <video className="call-video" ref={videoRef} autoPlay playsInline muted={muted} />;
}

/** Retains only the watched picture in memory; audio remains owned by RemoteAudio. */
export function RecoveringScreenVideo({
  stream,
  connectionStatus,
  onPlaybackReady,
  t
}: {
  stream: MediaStream | null;
  connectionStatus: StageSource["connectionStatus"];
  onPlaybackReady?: (track: MediaStreamTrack) => void;
  t: Translate;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const callback = useRef(onPlaybackReady);
  callback.current = onPlaybackReady;
  const [hasPicture, setHasPicture] = useState(false);
  const [decodedStream, setDecodedStream] = useState<MediaStream | null>(null);
  const decoded = Boolean(stream && decodedStream === stream);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !stream) return;
    let disposed = false;
    let frame: number | null = null;
    let lastCapture = -Infinity;
    const frameCallbacks = typeof video.requestVideoFrameCallback === "function";
    const capture = (force = false) => {
      const track = stream.getVideoTracks()[0];
      if (
        video.srcObject !== stream ||
        video.readyState < 2 ||
        !video.videoWidth ||
        track?.readyState !== "live" ||
        track.muted
      )
        return;
      const now = performance.now();
      if (!force && now - lastCapture < 1_000) return;
      try {
        const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
        const width = Math.max(1, Math.round(video.videoWidth * scale));
        const height = Math.max(1, Math.round(video.videoHeight * scale));
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        lastCapture = now;
        setHasPicture(true);
      } catch {
        /* Retain the previous picture if a track ends during capture. */
      }
    };
    const ready = () => {
      if (disposed || video.srcObject !== stream || video.readyState < 2 || !video.videoWidth) return;
      const track = stream.getVideoTracks()[0];
      if (!track || track.readyState !== "live" || track.muted) return;
      if (!frameCallbacks) capture();
      setDecodedStream(stream);
      callback.current?.(track);
    };
    const nextFrame = () => {
      if (disposed) return;
      capture();
      ready();
      frame = video.requestVideoFrameCallback(nextFrame);
    };
    const track = stream.getVideoTracks()[0];
    const unavailable = () => {
      capture(true);
      setDecodedStream(null);
    };
    track?.addEventListener("mute", unavailable);
    track?.addEventListener("ended", unavailable);
    track?.addEventListener("unmute", ready);
    video.addEventListener("loadeddata", ready);
    video.addEventListener("playing", ready);
    video.addEventListener("timeupdate", ready);
    video.srcObject = stream;
    if (frameCallbacks) frame = video.requestVideoFrameCallback(nextFrame);
    return () => {
      capture(true);
      disposed = true;
      if (frame !== null) video.cancelVideoFrameCallback(frame);
      video.removeEventListener("loadeddata", ready);
      video.removeEventListener("playing", ready);
      video.removeEventListener("timeupdate", ready);
      track?.removeEventListener("mute", unavailable);
      track?.removeEventListener("ended", unavailable);
      track?.removeEventListener("unmute", ready);
      video.srcObject = null;
    };
  }, [stream]);
  useEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }, []);
  const failed = connectionStatus === "failed";
  return (
    <span className="screen-playback">
      <canvas
        className="call-video screen-retained-picture"
        ref={canvasRef}
        hidden={!hasPicture || decoded || failed}
        aria-hidden="true"
      />
      <video className="call-video" ref={videoRef} autoPlay playsInline muted hidden={!decoded || failed} />
      {failed || (!hasPicture && !decoded) ? (
        <span className="screen-stage-placeholder">
          {t(failed ? "voice.retry" : connectionStatus === "reconnecting" ? "voice.reconnecting" : "voice.connecting")}
        </span>
      ) : null}
      {!failed && hasPicture && connectionStatus === "reconnecting" ? (
        <span className="screen-recovery-overlay" role="status">
          {t("voice.reconnecting")}
        </span>
      ) : null}
    </span>
  );
}

export function RemoteAudio({ stream, muted, volume }: { stream: MediaStream; muted: boolean; volume: number }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const outputRef = useRef<AudioOutput | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || stream.getAudioTracks().length === 0) return;
    const output = connectAudioOutput(audio, stream, { muted, volume });
    outputRef.current = output;
    return () => {
      output.dispose();
      outputRef.current = null;
    };
  }, [stream]);

  useEffect(() => {
    outputRef.current?.setVolume(muted, volume);
  }, [muted, volume]);

  return <audio className="remote-audio" ref={audioRef} autoPlay />;
}

export function AudioPlaybackRecovery({ t }: { t: Translate }) {
  return (
    <div className="audio-playback-recovery" role="status">
      <span>{t("audio.playbackBlocked")}</span>
      <button className="btn btn-primary" type="button" onClick={() => void retryBlockedAudioOutputs()}>
        {t("audio.enablePlayback")}
      </button>
    </div>
  );
}

export function GlobalVoiceAudio({
  streams,
  muted,
  mutedUserIds,
  memberVolumes,
  outputVolume
}: {
  streams: RemoteStreamState[];
  muted: boolean;
  mutedUserIds: Set<string>;
  memberVolumes: Record<string, number>;
  outputVolume: number;
}) {
  return (
    <>
      {streams
        .filter((item) => item.kind === "audio")
        .map((item) => (
          <RemoteAudio
            key={remoteStreamKey(item.userId, item.kind)}
            stream={item.stream}
            muted={muted || mutedUserIds.has(item.userId)}
            volume={combineOutputVolume(memberVolumes[item.userId] ?? DEFAULT_VOLUME_PERCENT, outputVolume)}
          />
        ))}
    </>
  );
}

export function VisualStage({
  sources,
  focusedSource,
  screenVolumes,
  onFocus,
  onDismiss,
  onUnwatch,
  onScreenVolumeChange,
  t
}: {
  sources: StageSource[];
  focusedSource: StageSource | null;
  screenVolumes: Record<string, number>;
  outputVolume: number;
  onFocus: (key: string) => void;
  onDismiss: (source: StageSource) => void;
  onUnwatch?: (source: StageSource) => void;
  onScreenVolumeChange: (streamId: string, volume: number) => void;
  t: Translate;
}) {
  const stageRef = useRef<HTMLElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const orderedSources = focusedSource
    ? [focusedSource, ...sources.filter((source) => source.key !== focusedSource.key)]
    : sources;
  const focusedStream = focusedSource?.stream ?? null;
  const focusedHasAudio = Boolean(focusedSource?.kind === "screen" && focusedStream?.getAudioTracks().length);
  const focusedVolume = focusedStream
    ? (screenVolumes[focusedStream.id] ?? DEFAULT_VOLUME_PERCENT)
    : DEFAULT_VOLUME_PERCENT;

  useEffect(() => {
    const syncFullscreenState = () => setIsFullscreen(document.fullscreenElement === stageRef.current);
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && document.fullscreenElement === stageRef.current) void document.exitFullscreen?.();
    };
    document.addEventListener("fullscreenchange", syncFullscreenState);
    document.addEventListener("keydown", exitOnEscape);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      document.removeEventListener("keydown", exitOnEscape);
    };
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement === stageRef.current) {
      void document.exitFullscreen?.();
      return;
    }
    void stageRef.current?.requestFullscreen?.();
  };

  return (
    <section
      ref={stageRef}
      className={`screen-stage stage-count-${Math.min(orderedSources.length, 4)}`}
      aria-label={t("voice.stage")}
    >
      <div className="stage-grid">
        {orderedSources.map((source) => (
          <StreamActions
            key={source.key}
            name={source.ownerName}
            watched={source.kind === "screen" && !source.ownerIsLocal && Boolean(onUnwatch)}
            volume={
              source.stream?.getAudioTracks().length
                ? (screenVolumes[source.stream.id] ?? DEFAULT_VOLUME_PERCENT)
                : undefined
            }
            onVolume={source.stream ? (value) => onScreenVolumeChange(source.stream!.id, value) : undefined}
            onUnwatch={() => onUnwatch?.(source)}
            t={t}
          >
            <button
              className={`stage-media ${source.key === focusedSource?.key ? "is-focused" : ""}`}
              type="button"
              onClick={() => {
                if (source.connectionStatus === "failed" && source.onRetry) {
                  source.onRetry();
                  return;
                }
                const action = stageClickAction(
                  document.fullscreenElement === stageRef.current,
                  source.key === focusedSource?.key
                );
                if (action === "exit-fullscreen") {
                  void document.exitFullscreen?.();
                  return;
                }
                if (action === "dismiss") onDismiss(source);
                else onFocus(source.key);
              }}
              aria-pressed={source.key === focusedSource?.key}
              aria-label={
                source.connectionStatus === "failed"
                  ? t("voice.retry")
                  : isFullscreen
                    ? t("common.exitFullscreen")
                    : t(source.key === focusedSource?.key ? "voice.removeFromStage" : "voice.addToStage", {
                        nickname: source.ownerName
                      })
              }
            >
              {source.kind === "screen" && !source.ownerIsLocal ? (
                <RecoveringScreenVideo
                  stream={source.stream}
                  connectionStatus={source.connectionStatus}
                  onPlaybackReady={source.onPlaybackReady}
                  t={t}
                />
              ) : source.stream ? (
                <RemoteVideo stream={source.stream} muted />
              ) : (
                <span className="screen-stage-placeholder">{t("voice.connecting")}</span>
              )}
              {source.connectionWarning ? (
                <span
                  className="screen-connection-mark"
                  role="img"
                  aria-label={t("voice.screenConnectionWarning")}
                  title={t("voice.screenConnectionWarning")}
                >
                  !
                </span>
              ) : null}
              {source.key !== focusedSource?.key ? (
                <span className="stage-media-label">
                  <strong>{source.ownerName}</strong>
                  <span>{source.kind === "screen" ? t("status.screenSharing") : t("status.cameraOn")}</span>
                </span>
              ) : null}
            </button>
          </StreamActions>
        ))}
      </div>
      <div className="screen-stage-bar">
        <button
          className="btn btn-ghost stage-back"
          type="button"
          onClick={() => {
            if (document.fullscreenElement === stageRef.current) {
              void document.exitFullscreen?.();
              return;
            }
            if (focusedSource) onDismiss(focusedSource);
          }}
        >
          {isFullscreen ? t("common.exitFullscreen") : t("voice.backToBox")}
        </button>
        <span>
          <strong>{focusedSource?.ownerName}</strong>
          <span className="muted small">
            {focusedSource?.kind === "screen" ? t("status.screenSharing") : t("status.cameraOn")}
          </span>
        </span>
        {focusedSource?.connectionWarning ? <ScreenConnectionWarning t={t} /> : null}
        {!focusedSource?.ownerIsLocal && focusedSource?.kind === "screen" ? (
          focusedHasAudio && focusedStream ? (
            <details className="volume-popover stage-volume">
              <summary aria-label={t("voice.screenVolume")}>
                <VolumeIcon />
              </summary>
              <VolumeControl
                label={t("voice.screenVolume")}
                value={focusedVolume}
                onChange={(volume) => onScreenVolumeChange(focusedStream.id, volume)}
              />
            </details>
          ) : (
            <button
              className="icon-btn screen-audio-unavailable"
              type="button"
              disabled
              aria-label={t("voice.noScreenAudio")}
              title={t("voice.noScreenAudio")}
            >
              <VolumeIcon />
            </button>
          )
        ) : null}
        <button
          className="icon-btn"
          type="button"
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? t("common.exitFullscreen") : t("common.fullscreen")}
        >
          <MaximizeIcon />
          <span>{isFullscreen ? t("common.exitFullscreen") : t("common.fullscreen")}</span>
        </button>
      </div>
    </section>
  );
}

export function ScreenConnectionWarning({ t }: { t: Translate }) {
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  return (
    <div className={`screen-connection-warning${open ? " is-open" : ""}`}>
      <button
        type="button"
        aria-label={t("voice.screenConnectionWarning")}
        aria-describedby={descriptionId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        !
      </button>
      <span id={descriptionId} role="tooltip">
        {t("voice.screenConnectionWarning")}
      </span>
    </div>
  );
}
