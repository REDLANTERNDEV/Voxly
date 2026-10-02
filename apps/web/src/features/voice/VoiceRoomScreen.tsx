import type { VisualMediaKind,VisualTarget } from "@voxly/shared";
import { useEffect,useRef,useState } from "react";
import { serverPath } from "../../app/navigation.js";
import { initial,presenceFromUser } from "../../app/presentation.js";
import type { LiveWatchRequest,ShellActions,ShellModel,VoiceChromeModel } from "../../app/types.js";
import { ScreenIcon } from "../../components/ui/Icons.js";
import { EmptyState,RoomHeader } from "../../components/ui/Primitives.js";
import { resolveRememberedRoom } from "../../lib/channelState.js";
import { connectionStatusFor } from "../../lib/voiceNegotiation.js";
import { visualTargetKey } from "../../lib/voiceResume.js";
import { participantsForViewedRoom,remoteStreamKey } from "../../lib/voiceStreams.js";
import { StageMemberActions } from "../../components/shell/StageMemberActions.js";
import { countPeople } from "../../lib/memberDirectory.js";
import { stageTileSelection } from "./stageTileSelection.js";
import { MusicPanel } from "./MusicPanel.js";
import { RemoteVideo,VisualStage,VoiceStatusBadges,type StageSource } from "./VoicePresentation.js";

type VoiceRoomProps = Pick<ShellModel,
  "user" | "currentNickname" | "route" | "activeServerId" | "rooms" | "socketState" |
  "roomHistory" | "t" | "currentRoom"
> & Pick<VoiceChromeModel,
  "activeVoiceRoomId" | "controls" | "visualTargets" | "voiceSnapshots" | "musicQueues" | "remoteStreams" |
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
  const [selectionPending, setSelectionPending] = useState(false);
  const selectionPendingRef = useRef(false);
  const liveWatchAttemptRef = useRef<LiveWatchRequest | null>(null);
  const latestWatch = useRef(props.pendingLiveWatch);
  latestWatch.current = props.pendingLiveWatch;
  const tileButtons = useRef(new Map<string, HTMLButtonElement>());
  const viewedRoomId = props.currentRoom?.id ?? (props.route.name === "voice" ? props.route.roomId : props.activeVoiceRoomId);
  const viewedSnapshot = viewedRoomId ? props.voiceSnapshots[viewedRoomId] : undefined;
  const snapshotMembers = viewedSnapshot?.members ?? [];
  const participants = participantsForViewedRoom(
    viewedSnapshot,
    viewedRoomId,
    props.activeVoiceRoomId,
    presenceFromUser(props.user, props.currentNickname)
  );
  const connectedCount = countPeople(participants);
  const inViewedVoiceRoom = Boolean(viewedRoomId && props.activeVoiceRoomId === viewedRoomId
    && viewedSnapshot?.viewerInVoiceRoom && snapshotMembers.some((member) => member.user.userId === props.user.id));
  const streamByKey = new Map((inViewedVoiceRoom ? props.remoteStreams : []).map((item) => [remoteStreamKey(item.userId, item.kind), item.stream]));
  for (const preview of inViewedVoiceRoom ? props.localPreviews : []) {
    streamByKey.set(remoteStreamKey(props.user.id, preview.kind), preview.stream);
  }
  const mediaByUser = new Map(snapshotMembers.map((member) => [member.user.userId, member.media]));
  const moderationByUser = new Map(snapshotMembers.map((member) => [member.user.userId, member.moderation]));
  const mediaFor = (userId: string) => userId === props.user.id && inViewedVoiceRoom
    ? {
        mic: props.controls.mic.on && (mediaByUser.get(userId)?.mic ?? true),
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
  const selectedRemoteKeys = new Set(inViewedVoiceRoom ? props.visualTargets.map(visualTargetKey) : []);
  const selectedKeys = new Set([...selectedRemoteKeys, ...(inViewedVoiceRoom ? localStageKeys : [])]);
  const stageSources = (inViewedVoiceRoom ? visualSources : []).filter((source) => selectedKeys.has(source.key));
  const focusedSource = stageSources.find((source) => source.key === focusedSourceKey) ?? stageSources[0] ?? null;
  const hasVoiceActivity = Boolean(props.activeVoiceRoomId || snapshotMembers.length > 0);
  const targetTextRoom = resolveRememberedRoom(
    props.rooms.text,
    props.roomHistory[props.activeServerId]?.text
  );

  const selectionGeneration = useRef(0);
  const latestSelection = useRef({ targets: props.visualTargets, clear: props.onSetVisualSubscriptions });
  latestSelection.current = { targets: props.visualTargets, clear: props.onSetVisualSubscriptions };
  useEffect(() => {
    selectionGeneration.current += 1;
    selectionPendingRef.current = false; setSelectionPending(false);
    setLocalStageKeys([]); setFocusedSourceKey(null); setStageStatus("");
    return () => {
      selectionGeneration.current += 1;
      if (latestSelection.current.targets.length) void latestSelection.current.clear([]).catch(() => undefined);
    };
  }, [viewedRoomId]);

  const availableSourceKeys = visualSources.map((source) => source.key).join("|");
  useEffect(() => {
    const available = new Set(visualSources.map((source) => source.key));
    setLocalStageKeys((keys) => keys.filter((key) => available.has(key)));
    setFocusedSourceKey((key) => key && available.has(key) ? key : null);
    if (!inViewedVoiceRoom) return;
    const remaining = props.visualTargets.filter((target) => available.has(visualTargetKey(target)));
    if (remaining.length !== props.visualTargets.length) void props.onSetVisualSubscriptions(remaining).catch(() => undefined);
  }, [availableSourceKeys, inViewedVoiceRoom]);

  const updateRemoteSelection = async (targets: VisualTarget[], focusKey: string | null) => {
    const generation = selectionGeneration.current;
    const response = await props.onSetVisualSubscriptions(targets);
    if (generation !== selectionGeneration.current) return false;
    if (response.ok) {
      setFocusedSourceKey(focusKey);
      setStageStatus("");
      return true;
    }
    props.onRequestVoiceSnapshot(viewedRoomId ?? props.activeVoiceRoomId ?? "");
    setStageStatus(props.t("voice.sourceUnavailable"));
    return false;
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
    if (selectionPendingRef.current) return;
    const selection = stageTileSelection(selectedKeys, source);
    const generation = selectionGeneration.current;
    selectionPendingRef.current = true;
    setSelectionPending(true);
    void updateRemoteSelection(selection.targets, selection.focusKey)
      .then((ok) => {
        if (!ok || generation !== selectionGeneration.current) return;
        setLocalStageKeys(selection.localKeys);
        if (selectedKeys.has(source.key)) window.setTimeout(() => tileButtons.current.get(source.key)?.focus(), 0);
      })
      .catch(() => { if (generation === selectionGeneration.current) setStageStatus(props.t("voice.sourceUnavailable")); })
      .finally(() => { if (generation === selectionGeneration.current) { selectionPendingRef.current = false; setSelectionPending(false); } });
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
    const generation = selectionGeneration.current;
    void props.onJoinVoice(viewedRoomId, {
      microphoneEnabled: true,
      visualTargets: [{ publisherUserId: pendingLiveWatch.publisherUserId, kind: "screen" }]
    }).then((ok) => {
      if (!ok && generation === selectionGeneration.current && latestWatch.current === pendingLiveWatch) { setStageStatus(props.t("voice.sourceUnavailable")); props.onLiveWatchHandled(); }
    }).catch(() => {
      if (generation !== selectionGeneration.current || latestWatch.current !== pendingLiveWatch) return;
      setStageStatus(props.t("voice.sourceUnavailable")); props.onLiveWatchHandled();
    });
  }, [pendingLiveWatch, props.activeVoiceRoomId, props.socketState, requestedLiveSource?.key, viewedRoomId]);

  useEffect(() => {
    if (!pendingLiveWatch || props.socketState !== "live" || !inViewedVoiceRoom || !requestedLiveSource) return;
    if (requestedLiveSource.ownerIsLocal) {
      setLocalStageKeys([requestedLiveSource.key]);
      setFocusedSourceKey(requestedLiveSource.key);
      props.onLiveWatchHandled();
      return;
    }
    if (!requestedLiveSource.target) return;
    const generation = selectionGeneration.current;
    void updateRemoteSelection([requestedLiveSource.target], requestedLiveSource.key)
      .then((ok) => { if (ok && generation === selectionGeneration.current) setLocalStageKeys([]); })
      .catch(() => { if (generation === selectionGeneration.current) setStageStatus(props.t("voice.sourceUnavailable")); })
      .finally(() => { if (generation === selectionGeneration.current && latestWatch.current === pendingLiveWatch) props.onLiveWatchHandled(); });
  }, [pendingLiveWatch?.publisherUserId, inViewedVoiceRoom, props.socketState, requestedLiveSource?.key, viewedRoomId]);

  useEffect(() => {
    if (pendingLiveWatch && viewedSnapshot && props.socketState === "live" && !requestedLiveSource) {
      setStageStatus(props.t("voice.sourceUnavailable")); props.onLiveWatchHandled();
    }
  }, [pendingLiveWatch, Boolean(viewedSnapshot), requestedLiveSource?.key, props.socketState]);

  return (
    <main className="main-panel" id="main-content">
        <RoomHeader
          title={props.currentRoom?.name ?? props.t("room.lobbyVoice")}
          subtitle={props.t("common.connected", { count: connectedCount })}
          kind="voice"
          actionLabel={targetTextRoom ? props.t("room.openChannel", { channel: targetTextRoom.name }) : undefined}
          onAction={targetTextRoom ? () => props.onNavigate(serverPath(props.activeServerId, "text", targetTextRoom.id)) : undefined}
        />
        {hasVoiceActivity ? (
          <section className="call-surface voice-control-room" aria-label={props.t("room.voiceRooms")}>
            {stageSources.length > 0 ? <VisualStage
              sources={stageSources} focusedSource={focusedSource}
              screenVolumes={props.screenVolumes} outputVolume={props.audioLevels.output}
              onFocus={setFocusedSourceKey} onDismiss={watchSource} onScreenVolumeChange={props.onScreenVolumeChange} t={props.t}
            /> : null}
            <ul className="voice-tile-grid" aria-label={props.t("common.members")}>
              {participants.map((participant) => {
                const media = mediaFor(participant.userId);
                const moderation = moderationByUser.get(participant.userId);
                const isSpeaking = Boolean(inViewedVoiceRoom && media?.speaking && media.mic && !media.deafened && !moderation?.muted);
                const camera = visualSources.find((source) => source.ownerId === participant.userId && source.kind === "camera");
                return <li className={`voice-person-tile ${isSpeaking ? "is-speaking" : ""} ${camera && selectedKeys.has(camera.key) ? "is-selected" : ""}`} key={participant.userId}>
                  <StageMemberActions member={participant} roomId={viewedRoomId ?? ""} moderation={moderation}>
                    {camera && inViewedVoiceRoom ? <button className="voice-person-watch" ref={(button) => { if (button) tileButtons.current.set(camera.key, button); else tileButtons.current.delete(camera.key); }} type="button"
                      disabled={props.socketState !== "live" || selectionPending}
                      aria-pressed={selectedKeys.has(camera.key)}
                      aria-label={props.t(selectedKeys.has(camera.key) ? "voice.removeFromStage" : "voice.addToStage", { nickname: participant.nickname })}
                      onClick={() => watchSource(camera)}>
                      {camera.stream ? <RemoteVideo stream={camera.stream} muted /> : <span className="call-avatar" aria-hidden="true">{initial(participant.nickname)}</span>}
                      <span className="voice-tile-caption"><strong>{participant.nickname}</strong><VoiceStatusBadges media={media} moderation={moderation} t={props.t} showVisual={false} /></span>
                    </button> : <>
                      <span className="call-avatar" aria-hidden="true">{initial(participant.nickname)}</span>
                      <span className="voice-tile-caption"><strong>{participant.nickname}</strong><VoiceStatusBadges media={media} moderation={moderation} t={props.t} showVisual={false} /></span>
                    </>}

                  </StageMemberActions>
                </li>;
              })}
              {visualSources.filter((source) => source.kind === "screen").map((source) => {
                const selected = selectedKeys.has(source.key);
                return <li className={`voice-stream-tile ${selected ? "is-selected" : ""}`} key={source.key}>
                  <button className="voice-stream-watch" ref={(button) => { if (button) tileButtons.current.set(source.key, button); else tileButtons.current.delete(source.key); }} type="button" disabled={props.socketState !== "live" || selectionPending} onClick={() => watchSource(source)} aria-pressed={selected} aria-label={selected ? props.t("voice.removeFromStage", { nickname: source.ownerName }) : `${props.t("voice.watchStream")} — ${source.ownerName}`}>
                    {source.ownerIsLocal && source.stream ? <RemoteVideo stream={source.stream} muted /> : selected && inViewedVoiceRoom && source.stream ? <RemoteVideo stream={source.stream} muted /> : <span className="stream-unwatched-background" aria-hidden="true" />}
                    {!selected && !source.ownerIsLocal ? <span className="stream-watch-label">{props.t("voice.watchStream")}</span> : null}
                    {selected ? <span className="selected-stream-mark" aria-hidden="true"><ScreenIcon off={false} /></span> : null}
                    <span className="tile-live">{props.t("common.live")}</span>
                    <span className="voice-tile-caption"><strong>{source.ownerName}</strong><VoiceStatusBadges media={mediaFor(source.ownerId)} moderation={moderationByUser.get(source.ownerId)} t={props.t} showVisual={false} />{!selected ? <ScreenIcon off={false} /> : null}</span>
                  </button>

                </li>;
              })}
            </ul>

            {inViewedVoiceRoom ? (
              <MusicPanel
                members={snapshotMembers}
                queues={props.musicQueues}
                roomId={viewedRoomId ?? null}
                connected={props.socketState === "live"}
                onMusicControl={props.onMusicControl}
                t={props.t}
              />
            ) : null}
            {stageStatus ? <p className="voice-stage-status" aria-live="polite">{stageStatus}</p> : null}
          </section>
        ) : (
          <section className="call-surface">
            <EmptyState title={props.t("room.noActiveVoice")} copy={props.t("room.noActiveVoiceCopy")} kind="voice" />
          </section>
        )}
    </main>
  );
}
