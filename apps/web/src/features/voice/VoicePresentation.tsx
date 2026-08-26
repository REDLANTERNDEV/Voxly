import type { VisualMediaKind,VisualTarget,VoiceMediaState,VoiceModerationState } from "@voxly/shared";
import { useEffect,useRef,useState } from "react";
import { voiceStatusItems } from "../../app/presentation.js";
import type { Translate } from "../../app/types.js";
import { MaximizeIcon,VolumeIcon } from "../../components/ui/Icons.js";
import { VolumeControl } from "../../components/ui/Primitives.js";
import { combineOutputVolume } from "../../lib/audioLevels.js";
import { connectAudioOutput,retryBlockedAudioOutputs,type AudioOutput } from "../../lib/audioOutput.js";
import { remoteStreamKey,type RemoteStreamState } from "../../lib/voiceStreams.js";
import { DEFAULT_VOLUME_PERCENT } from "../../lib/voiceVolume.js";
export interface StageSource {
  key: string;
  kind: VisualMediaKind;
  ownerId: string;
  ownerName: string;
  ownerIsLocal: boolean;
  stream: MediaStream | null;
  target: VisualTarget | null;
  connectionStatus: "connecting" | "failed" | "ready";
}
export function VoiceStatusBadges({ media, moderation, t, compact = false }: { media: VoiceMediaState | undefined; moderation?: VoiceModerationState; t: Translate; compact?: boolean }) {
  const items = voiceStatusItems(media, moderation, t);
  if (items.length === 0) {
    return null;
  }

  return (
    <span className={`voice-status-list ${compact ? "is-compact" : ""}`}>
      {items.map((item) => (
        <span className={`voice-status-chip ${item.tone}`} key={item.label}>
          {item.icon}
          <span>{item.label}</span>
        </span>
      ))}
    </span>
  );
}

export function RemoteVideo({ stream, muted = false }: { stream: MediaStream; muted?: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);
  return <video className="call-video" ref={videoRef} autoPlay playsInline muted={muted} />;
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

  return <audio className="remote-audio" ref={audioRef} autoPlay muted={muted} />;
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
      {streams.filter((item) => item.kind === "audio").map((item) => (
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
  outputVolume,
  onFocus,
  onScreenVolumeChange,
  t
}: {
  sources: StageSource[];
  focusedSource: StageSource | null;
  screenVolumes: Record<string, number>;
  outputVolume: number;
  onFocus: (key: string) => void;
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
  const focusedVolume = focusedStream ? screenVolumes[focusedStream.id] ?? DEFAULT_VOLUME_PERCENT : DEFAULT_VOLUME_PERCENT;

  useEffect(() => {
    const syncFullscreenState = () => setIsFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement === stageRef.current) {
      void document.exitFullscreen?.();
      return;
    }
    void stageRef.current?.requestFullscreen?.();
  };

  return (
    <section ref={stageRef} className={`screen-stage stage-count-${Math.min(orderedSources.length, 4)}`} aria-label={t("voice.stage")}>
      <div className="stage-grid">
        {orderedSources.map((source) => (
          <button
            className={`stage-media ${source.key === focusedSource?.key ? "is-focused" : ""}`}
            type="button"
            key={source.key}
            onClick={() => onFocus(source.key)}
            aria-pressed={source.key === focusedSource?.key}
            aria-label={`${source.ownerName} ${source.kind === "screen" ? t("status.screenSharing") : t("status.cameraOn")}`}
          >
            {source.stream ? <RemoteVideo stream={source.stream} muted /> : <span className="screen-stage-placeholder">{source.connectionStatus === "failed" ? t("voice.retry") : t("voice.connecting")}</span>}
            {source.key !== focusedSource?.key ? <span className="stage-media-label"><strong>{source.ownerName}</strong><span>{source.kind === "screen" ? t("status.screenSharing") : t("status.cameraOn")}</span></span> : null}
          </button>
        ))}
      </div>
      {!focusedSource?.ownerIsLocal && focusedSource?.kind === "screen" && focusedStream && focusedHasAudio ? <RemoteAudio stream={focusedStream} muted={false} volume={combineOutputVolume(focusedVolume, outputVolume)} /> : null}
      <div className="screen-stage-bar">
        <span><strong>{focusedSource?.ownerName}</strong><span className="muted small">{focusedSource?.kind === "screen" ? t("status.screenSharing") : t("status.cameraOn")}</span></span>
        {!focusedSource?.ownerIsLocal && focusedSource?.kind === "screen" ? (
          focusedHasAudio && focusedStream
            ? <details className="volume-popover stage-volume"><summary aria-label={t("voice.screenVolume")}><VolumeIcon /></summary><VolumeControl label={t("voice.screenVolume")} value={focusedVolume} onChange={(volume) => onScreenVolumeChange(focusedStream.id, volume)} /></details>
            : <button className="icon-btn screen-audio-unavailable" type="button" disabled aria-label={t("voice.noScreenAudio")} title={t("voice.noScreenAudio")}><VolumeIcon /></button>
        ) : null}
        <button className="icon-btn" type="button" onClick={toggleFullscreen} aria-label={isFullscreen ? t("common.exitFullscreen") : t("common.fullscreen")}>
          <MaximizeIcon />
          <span>{isFullscreen ? t("common.exitFullscreen") : t("common.fullscreen")}</span>
        </button>
      </div>
    </section>
  );
}
