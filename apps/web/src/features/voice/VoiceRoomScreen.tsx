import type { VisualMediaKind,VisualTarget } from "@voxly/shared";
import { useEffect,useRef,useState } from "react";
import { serverPath } from "../../app/navigation.js";
import { initial,presenceFromUser } from "../../app/presentation.js";
import type { LiveWatchRequest,ShellActions,ShellModel,VoiceChromeModel } from "../../app/types.js";
import { EyeIcon,VolumeIcon } from "../../components/ui/Icons.js";
import { EmptyState,RoomHeader,VolumeControl } from "../../components/ui/Primitives.js";
import { resolveRememberedRoom } from "../../lib/channelState.js";
import { connectionStatusFor } from "../../lib/voiceNegotiation.js";
import { replaceVisualTarget,toggleVisualTarget,visualTargetKey } from "../../lib/voiceResume.js";
import { participantsForViewedRoom,remoteStreamKey } from "../../lib/voiceStreams.js";
import { DEFAULT_VOLUME_PERCENT } from "../../lib/voiceVolume.js";
import { MusicPanel } from "./MusicPanel.js";
import { RemoteVideo,VisualStage,VoiceStatusBadges,type StageSource } from "./VoicePresentation.js";

type VoiceRoomProps = Pick<ShellModel,
  "user" | "currentNickname" | "route" | "activeServerId" | "rooms" | "socketState" |
  "roomHistory" | "t" | "currentRoom"
> & Pick<VoiceChromeModel,
  "activeVoiceRoomId" | "controls" | "visualTargets" | "voiceSnapshots" | "remoteStreams" |
  "peerConnectionStates" | "localPreviews" | "memberVolumes" | "screenVolumes" |
  "pendingLiveWatch" | "audioLevels"
> & Pick<ShellActions,
  "onNavigate" | "onJoinVoice" | "onWatchLive" | "onLiveWatchHandled" |
  "onRequestVoiceSnapshot" | "onSetVisualSubscriptions" | "onMemberVolumeChange" |
  "onScreenVolumeChange" | "onMusicControl"
>;

export function VoiceRoomScreen(props: VoiceRoomProps) {
  const [localStageKeys, setLocalStageKeys] = useState<string[]>([]);
  const [focusedSourceKey, setFocusedSourceKey] = useState<string | null>(null);
  const [stageStatus, setStageStatus] = useState("");
  const liveWatchAttemptRef = useRef<LiveWatchRequest | null>(null);
  const viewedRoomId = props.currentRoom?.id ?? (props.route.name === "voice" ? props.route.roomId : props.activeVoiceRoomId);
  const viewedSnapshot = viewedRoomId ? props.voiceSnapshots[viewedRoomId] : undefined;
  const snapshotMembers = viewedSnapshot?.members ?? [];
  const participants = participantsForViewedRoom(
    viewedSnapshot,
    viewedRoomId,
    props.activeVoiceRoomId,
    presenceFromUser(props.user, props.currentNickname)
  );
  const connectedCount = participants.length;
  const streamByKey = new Map(props.remoteStreams.map((item) => [remoteStreamKey(item.userId, item.kind), item.stream]));
  for (const preview of props.localPreviews) {
    streamByKey.set(remoteStreamKey(props.user.id, preview.kind), preview.stream);
  }
  const mediaByUser = new Map(snapshotMembers.map((member) => [member.user.userId, member.media]));
  const moderationByUser = new Map(snapshotMembers.map((member) => [member.user.userId, member.moderation]));
  const mediaFor = (userId: string) => userId === props.user.id
    ? {
        mic: props.controls.mic.on,
        camera: props.controls.camera.on,
        screen: props.controls.screenShare.on,
        deafened: props.controls.deafen.on,
        speaking: mediaByUser.get(userId)?.speaking ?? false
      }
    : mediaByUser.get(userId);
  const visualSources: StageSource[] = participants.flatMap((participant) => {
    const media = mediaFor(participant.userId);
    return (["camera", "screen"] as const)
      .filter((kind) => media?.[kind])
      .map((kind) => ({
        key: visualTargetKey({ publisherUserId: participant.userId, kind }),
        kind,
        ownerId: participant.userId,
        ownerName: participant.nickname,
        ownerIsLocal: participant.userId === props.user.id,
        stream: streamByKey.get(remoteStreamKey(participant.userId, kind)) ?? null,
        target: participant.userId === props.user.id ? null : { publisherUserId: participant.userId, kind },
        connectionStatus: participant.userId === props.user.id
          ? "ready"
          : connectionStatusFor(props.peerConnectionStates[participant.userId] ?? "new", Boolean(streamByKey.get(remoteStreamKey(participant.userId, kind))))
      }));
  });
  const pendingLiveWatch = props.pendingLiveWatch?.roomId === viewedRoomId ? props.pendingLiveWatch : null;
  const requestedLiveSource = pendingLiveWatch
    ? visualSources.find((source) => source.ownerId === pendingLiveWatch.publisherUserId && source.kind === "screen") ?? null
    : null;
  const selectedRemoteKeys = new Set(props.visualTargets.map(visualTargetKey));
  const selectedKeys = new Set([...selectedRemoteKeys, ...localStageKeys]);
  const stageSources = visualSources.filter((source) => selectedKeys.has(source.key));
  const focusedSource = stageSources.find((source) => source.key === focusedSourceKey) ?? stageSources[0] ?? null;
  const hasVoiceActivity = Boolean(props.activeVoiceRoomId || snapshotMembers.length > 0);
  const targetTextRoom = resolveRememberedRoom(
    props.rooms.text,
    props.roomHistory[props.activeServerId]?.text
  );

  const updateRemoteSelection = async (targets: VisualTarget[], focusKey: string) => {
    const response = await props.onSetVisualSubscriptions(targets);
    if (response.ok) {
      setFocusedSourceKey(focusKey);
      setStageStatus("");
      return;
    }
    props.onRequestVoiceSnapshot(viewedRoomId ?? props.activeVoiceRoomId ?? "");
    setStageStatus(props.t("voice.sourceUnavailable"));
  };

  const watchSource = (source: StageSource) => {
    if (
      !source.ownerIsLocal &&
      source.kind === "screen" &&
      viewedRoomId &&
      props.activeVoiceRoomId !== viewedRoomId
    ) {
      props.onWatchLive({
        serverId: props.activeServerId,
        roomId: viewedRoomId,
        publisherUserId: source.ownerId,
        nickname: source.ownerName
      });
      return;
    }
    if (source.ownerIsLocal) {
      setLocalStageKeys([source.key]);
      setFocusedSourceKey(source.key);
      return;
    }
    if (source.target) void updateRemoteSelection(replaceVisualTarget(props.visualTargets, source.target), source.key);
  };

  const toggleSource = (source: StageSource) => {
    if (source.ownerIsLocal) {
      setLocalStageKeys((current) => current.includes(source.key)
        ? current.filter((key) => key !== source.key)
        : [...current, source.key]);
      setFocusedSourceKey(source.key);
      return;
    }
    if (source.target) void updateRemoteSelection(toggleVisualTarget(props.visualTargets, source.target), source.key);
  };

  useEffect(() => {
    if (!pendingLiveWatch) {
      liveWatchAttemptRef.current = null;
      return;
    }
    if (props.socketState !== "live" || !viewedRoomId || props.activeVoiceRoomId === viewedRoomId || !requestedLiveSource) return;
    if (liveWatchAttemptRef.current === pendingLiveWatch) return;
    liveWatchAttemptRef.current = pendingLiveWatch;
    setStageStatus("");
    void props.onJoinVoice(viewedRoomId, {
      microphoneEnabled: true,
      visualTargets: [{ publisherUserId: pendingLiveWatch.publisherUserId, kind: "screen" }]
    }).catch(() => {
      if (liveWatchAttemptRef.current === pendingLiveWatch) liveWatchAttemptRef.current = null;
      setStageStatus(props.t("voice.sourceUnavailable"));
    });
  }, [pendingLiveWatch, props.activeVoiceRoomId, props.socketState, requestedLiveSource?.key, viewedRoomId]);

  useEffect(() => {
    if (!pendingLiveWatch || props.socketState !== "live" || props.activeVoiceRoomId !== viewedRoomId || !requestedLiveSource) return;
    if (requestedLiveSource.ownerIsLocal) {
      setLocalStageKeys([requestedLiveSource.key]);
      setFocusedSourceKey(requestedLiveSource.key);
      props.onLiveWatchHandled();
      return;
    }
    if (!requestedLiveSource.target) return;
    void updateRemoteSelection([requestedLiveSource.target], requestedLiveSource.key).finally(props.onLiveWatchHandled);
  }, [pendingLiveWatch?.publisherUserId, props.activeVoiceRoomId, props.socketState, requestedLiveSource?.key, viewedRoomId]);

  return (
    <main className="main-panel" id="main-content">
        <RoomHeader
          title={props.currentRoom?.name ?? props.t("room.lobbyVoice")}
          subtitle={props.t("room.pushToMute", { count: connectedCount })}
          actionLabel={targetTextRoom ? props.t("room.openChannel", { channel: targetTextRoom.name }) : undefined}
          onAction={targetTextRoom ? () => props.onNavigate(serverPath(props.activeServerId, "text", targetTextRoom.id)) : undefined}
        />
        {hasVoiceActivity ? (
          <section className="call-surface voice-control-room" aria-label={props.t("room.voiceRooms")}>
            {stageSources.length > 0 ? (
              <VisualStage
                sources={stageSources}
                focusedSource={focusedSource}
                screenVolumes={props.screenVolumes}
                outputVolume={props.audioLevels.output}
                onFocus={setFocusedSourceKey}
                onScreenVolumeChange={props.onScreenVolumeChange}
                t={props.t}
              />
            ) : (
              <section className="stage-empty" aria-live="polite">
                <p className="label">{props.t("voice.stage")}</p>
                <strong>{pendingLiveWatch ? props.t("voice.liveReady", { nickname: pendingLiveWatch.nickname }) : props.t("voice.chooseSource")}</strong>
                <span>{pendingLiveWatch ? props.t("voice.liveReadyCopy") : props.t("voice.chooseSourceCopy")}</span>
              </section>
            )}

            {visualSources.length > 0 ? (
              <section className="visual-source-rail" aria-labelledby="sourceRailTitle">
                <header className="compact-section-head">
                  <div><p className="label" id="sourceRailTitle">{props.t("voice.sources")}</p><span>{props.t("voice.sourcesCopy")}</span></div>
                  <span className="muted small">{visualSources.length}</span>
                </header>
                <ul className="visual-source-list">
                  {visualSources.map((source) => {
                    const selected = selectedKeys.has(source.key);
                    return (
                      <li className={`visual-source ${selected ? "is-selected" : ""}`} key={source.key}>
                        <button className="visual-source-main" type="button" disabled={props.socketState !== "live"} onClick={() => watchSource(source)} aria-pressed={selected}>
                          <span className="source-thumb" aria-hidden="true">
                            {source.stream ? <RemoteVideo stream={source.stream} muted /> : <span>{source.connectionStatus === "failed" ? props.t("voice.retry") : props.t("voice.connecting")}</span>}
                          </span>
                          <span className="source-copy"><strong>{source.ownerName}</strong><span>{source.kind === "screen" ? props.t("status.screenSharing") : props.t("status.cameraOn")}</span></span>
                        </button>
                        <button
                          className={`icon-btn source-multi-toggle ${selected ? "is-active" : ""}`}
                          type="button"
                          disabled={props.socketState !== "live"}
                          onClick={() => toggleSource(source)}
                          aria-label={selected ? props.t("voice.removeFromStage", { nickname: source.ownerName }) : props.t("voice.addToStage", { nickname: source.ownerName })}
                          aria-pressed={selected}
                        >
                          <EyeIcon />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {viewedRoomId && props.activeVoiceRoomId === viewedRoomId ? (
              <MusicPanel
                members={snapshotMembers}
                roomId={viewedRoomId ?? null}
                connected={props.socketState === "live"}
                onMusicControl={props.onMusicControl}
                t={props.t}
              />
            ) : null}

            <section className="voice-participants" aria-labelledby="participantTitle">
              <header className="compact-section-head"><div><p className="label" id="participantTitle">{props.t("common.members")}</p><span>{props.t("room.pushToMute", { count: connectedCount })}</span></div></header>
              <ul className="participant-list">
                {participants.map((participant) => {
                  const media = mediaFor(participant.userId);
                  const moderation = moderationByUser.get(participant.userId);
                  const audioStream = participant.userId === props.user.id ? null : streamByKey.get(remoteStreamKey(participant.userId, "audio"));
                  const isSpeaking = Boolean(media?.speaking && media.mic && !media.deafened && !moderation?.muted);
                  return (
                    <li className={`participant-row ${isSpeaking ? "is-speaking" : ""}`} key={participant.userId}>
                      <span className="call-avatar" aria-hidden="true">{initial(participant.nickname)}</span>
                      <span className="participant-copy"><strong>{participant.nickname}</strong><VoiceStatusBadges media={media} moderation={moderation} t={props.t} /></span>
                      {audioStream ? (
                        <details className="volume-popover">
                          <summary aria-label={props.t("voice.memberVolume", { nickname: participant.nickname })}><VolumeIcon /></summary>
                          <VolumeControl
                            label={props.t("voice.memberVolume", { nickname: participant.nickname })}
                            value={props.memberVolumes[participant.userId] ?? DEFAULT_VOLUME_PERCENT}
                            onChange={(volume) => props.onMemberVolumeChange(participant.userId, volume)}
                          />
                        </details>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
            {stageStatus ? <p className="voice-stage-status" aria-live="polite">{stageStatus}</p> : null}
          </section>
        ) : (
          <section className="call-surface">
            <EmptyState title={props.t("room.noActiveVoice")} copy={props.t("room.noActiveVoiceCopy")} />
          </section>
        )}
    </main>
  );
}
