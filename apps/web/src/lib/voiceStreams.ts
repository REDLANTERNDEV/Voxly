import type { PresenceUser, VoiceSnapshot } from "@voxly/shared";

export type RemoteMediaKind = "audio" | "camera" | "screen";

export interface RemoteStreamState {
  userId: string;
  kind: RemoteMediaKind;
  stream: MediaStream;
}

export function remoteStreamKey(userId: string, kind: RemoteMediaKind) {
  return `${userId}:${kind}`;
}

export function participantsForViewedRoom(
  snapshot: VoiceSnapshot | undefined,
  viewedRoomId: string | null,
  activeRoomId: string | null,
  localUser: PresenceUser
) {
  if (snapshot) return snapshot.members.map((member) => member.user);
  return viewedRoomId && viewedRoomId === activeRoomId ? [localUser] : [];
}

export function upsertRemoteStream(
  streams: RemoteStreamState[],
  userId: string,
  kind: RemoteMediaKind,
  stream: MediaStream
) {
  return [
    ...streams.filter((item) => item.userId !== userId || item.kind !== kind),
    { userId, kind, stream }
  ];
}

export function removeRemoteStream(
  streams: RemoteStreamState[],
  userId: string,
  kind: RemoteMediaKind,
  expectedStream: MediaStream
) {
  return streams.filter((item) => (
    item.userId !== userId || item.kind !== kind || item.stream !== expectedStream
  ));
}

export function mediaStreamForTrack(
  track: MediaStreamTrack,
  associatedStreams: readonly MediaStream[],
  createStream: (tracks: MediaStreamTrack[]) => MediaStream = (tracks) => new MediaStream(tracks)
) {
  return associatedStreams[0] ?? createStream([track]);
}

export function pruneRemoteStreamsForSnapshot(
  streams: RemoteStreamState[],
  members: Array<{ userId: string; camera: boolean; screen: boolean }> | VoiceSnapshot["members"]
) {
  const mediaByUser = new Map<string, { camera: boolean; screen: boolean }>();
  for (const member of members) {
    if ("media" in member) {
      mediaByUser.set(member.user.userId, member.media);
    } else {
      mediaByUser.set(member.userId, member);
    }
  }

  return streams.filter((item) => {
    const media = mediaByUser.get(item.userId);
    if (!media) return false;
    if (item.kind === "camera") return media.camera;
    if (item.kind === "screen") return media.screen;
    return true;
  });
}
