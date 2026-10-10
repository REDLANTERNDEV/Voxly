import assert from "node:assert/strict";
import { it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VoiceRoomScreen } from "../src/features/voice/VoiceRoomScreen.js";
import { createInitialVoiceControls } from "../src/lib/voiceControls.js";
import { translate } from "../src/lib/i18n.js";
const room = {
  id: "voice",
  name: "Voice",
  serverId: "server",
  kind: "voice" as const,
  position: 0,
  categoryId: null,
  isAfk: false
};
const publisher = {
  user: { userId: "publisher", nickname: "Publisher", role: "member" as const },
  media: { mic: true, camera: true, screen: true, speaking: true, deafened: false },
  moderation: { muted: false, deafened: false },
  mediaInstanceId: "publisher-instance"
};
const stream = { id: "screen", getAudioTracks: () => [] } as unknown as MediaStream;
it("renders no video, stage, speaking activity, or Music panel outside the channel even with stale streams", () => {
  const html = renderToStaticMarkup(
    <VoiceRoomScreen
      screenConnectionWarnings={{}}
      user={{ id: "self", nickname: "Self", role: "member", bannedAt: null }}
      currentNickname="Self"
      route={{ name: "voice", roomId: room.id, serverId: room.serverId }}
      activeServerId="server"
      rooms={{ text: [], voice: [room] }}
      currentRoom={room}
      socketState="live"
      activeVoiceRoomId="elsewhere"
      controls={createInitialVoiceControls()}
      visualTargets={[{ publisherUserId: "publisher", kind: "screen" }]}
      voiceSnapshots={{ voice: { roomId: "voice", viewerInVoiceRoom: false, members: [publisher] } }}
      musicQueues={{}}
      remoteStreams={[
        { userId: "publisher", kind: "screen", stream },
        { userId: "publisher", kind: "camera", stream }
      ]}
      peerConnectionStates={{}}
      localPreviews={[]}
      memberVolumes={{}}
      screenVolumes={{}}
      roomHistory={{}}
      pendingLiveWatch={null}
      audioLevels={{ input: 100, output: 100 }}
      t={(key, values) => translate("en", key, values)}
      onNavigate={() => {}}
      onJoinVoice={async () => false}
      onWatchLive={() => {}}
      onLiveWatchHandled={() => {}}
      onRequestVoiceSnapshot={() => {}}
      onSetVisualSubscriptions={async () => ({ ok: true, targets: [] })}
      onMemberVolumeChange={() => {}}
      onScreenVolumeChange={() => {}}
      onMusicControl={async () => ({ ok: false, error: "not_in_voice_room" })}
    />
  );
  assert.doesNotMatch(html, /<video|screen-stage|is-speaking|music-panel|stream-avatar/);
  assert.match(html, /Watch stream/);
  assert.match(html, /stream-unwatched-background/);
});
