// Real React hooks with deterministic HTTP/signalling and synthetic capture.
import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useSessionController } from "../../src/app/useSessionController.js";
import { useWorkspaceController } from "../../src/app/useWorkspaceController.js";
import { useVoiceMedia } from "../../src/lib/useVoiceMedia.js";
import { RemoteAudio } from "../../src/features/voice/VoicePresentation.js";
import { VoiceRoomScreen } from "../../src/features/voice/VoiceRoomScreen.js";
import { TextRoomScreen } from "../../src/features/chat/TextRoomScreen.js";
import { createInitialVoiceControls } from "../../src/lib/voiceControls.js";
import { translate } from "../../src/lib/i18n.js";
import "../../src/styles.css";
import "../../src/visual-refresh.css";

const account = { id: "self", nickname: "Listener", role: "member", bannedAt: null };
const room = {
  id: "room-a",
  serverId: "server-a",
  name: "Room A",
  kind: "text",
  position: 0,
  categoryId: null,
  isAfk: false
};
const route = { name: "text", serverId: room.serverId, roomId: room.id };
const t = (key, parameters) => translate("en", key, parameters);
const noop = () => {};
const resolved = async () => {};
const empty = [];
const calls = {
  http: {},
  navigation: [],
  emissions: [],
  subscriptions: 0,
  captures: 0,
  liveJoins: 0,
  liveSelections: 0,
  handled: 0
};
const realFetch = window.fetch.bind(window);
let finishSession;
window.fetch = async (input, options) => {
  const path = String(input);
  if (!path.startsWith("/api/")) return realFetch(input, options);
  calls.http[path] = (calls.http[path] ?? 0) + 1;
  if (path === "/api/me")
    return new Promise((resolve) => {
      finishSession = resolve;
    });
  const bodies = {
    "/api/config": { clientVersion: null, publicUrl: null, turnstile: null, analytics: null },
    "/api/rtc/config": { iceServers: [], expiresAt: null },
    "/api/servers": { servers: [{ id: "server-a", name: "Server A", role: "member", afkTimeoutMinutes: 15 }] },
    "/api/servers/server-a/rooms": { rooms: [room], categories: [], uncategorizedPosition: 0 },
    "/api/servers/server-a/directory": { members: [] }
  };
  if (!(path in bodies)) throw new Error(`Unexpected fixture request: ${path}`);
  return Response.json(bodies[path]);
};
const navigate = (path) => calls.navigation.push(path);
const socketHandlers = new Map();
let joinedState;
const socket = {
  connected: true,
  on(event, handler) {
    calls.subscriptions++;
    const handlers = socketHandlers.get(event) ?? new Set();
    handlers.add(handler);
    socketHandlers.set(event, handlers);
  },
  off(event, handler) {
    socketHandlers.get(event)?.delete(handler);
  },
  emit(event, request, acknowledge) {
    calls.emissions.push(event);
    if (event === "voice:join") {
      joinedState = {
        user: { userId: account.id, nickname: account.nickname, role: account.role },
        media: request.media,
        moderation: { muted: false, deafened: false },
        mediaInstanceId: request.mediaInstanceId
      };
      acknowledge({ ok: true, state: joinedState });
    } else if (event === "voice:snapshot" && acknowledge) {
      acknowledge({
        roomId: request,
        viewerInVoiceRoom: Boolean(joinedState),
        members: joinedState ? [joinedState] : []
      });
    } else if (event === "voice:setMediaState") {
      joinedState = { ...joinedState, media: { ...joinedState.media, ...request.media } };
      acknowledge({ ok: true, state: joinedState });
    } else if (event === "voice:setVisualSubscriptions") acknowledge({ ok: true, targets: request.targets });
  }
};
const context = new AudioContext();
const capture = context.createMediaStreamDestination().stream;
navigator.mediaDevices.getUserMedia = async () => {
  calls.captures++;
  return capture.clone();
};

function SessionProbe(props) {
  const session = useSessionController(props.route ?? route, navigate);
  useEffect(() => {
    window.hookFixture.session = session;
  });
  return <output>{session.authState}</output>;
}
function WorkspaceProbe(props) {
  const roomServerIdsRef = useRef({});
  const routeRef = useRef(route);
  const workspace = useWorkspaceController({
    user: props.user ?? account,
    route,
    navigate,
    roomHistory: {},
    roomServerIdsRef,
    routeRef
  });
  useEffect(() => {
    window.hookFixture.workspace = workspace;
  });
  return <output>{String(workspace.workspaceReady)}</output>;
}
function VoiceProbe(props) {
  const voice = useVoiceMedia({
    socket,
    user: account,
    iceServers: empty,
    voiceRoomIds: empty,
    afkRoomIds: empty,
    microphoneDevices: [{ deviceId: "" }],
    ...props
  });
  useEffect(() => {
    window.hookFixture.voice = voice;
  });
  return <output>{voice.activeRoomId ?? "idle"}</output>;
}
const selfMember = {
  user: { userId: account.id, nickname: account.nickname, role: "member" },
  media: { mic: false, camera: false, screen: false, speaking: false, deafened: false },
  moderation: { muted: false, deafened: false }
};
const publisher = {
  ...selfMember,
  user: { userId: "publisher", nickname: "Publisher", role: "member" },
  media: { ...selfMember.media, screen: true }
};
const watchRequest = { serverId: room.serverId, roomId: room.id, publisherUserId: "publisher" };
let finishLiveJoin;
let finishLiveSelection;
const onJoinVoice = () => {
  calls.liveJoins++;
  return new Promise((resolve) => {
    finishLiveJoin = resolve;
  });
};
const onSetVisualSubscriptions = (targets) => {
  calls.liveSelections++;
  return new Promise((resolve) => {
    finishLiveSelection = () => resolve({ ok: true, targets });
  });
};
function LiveProbe(props) {
  return (
    <VoiceRoomScreen
      user={account}
      currentNickname={account.nickname}
      route={{ ...route, name: "voice" }}
      activeServerId={room.serverId}
      rooms={{ text: [], voice: [{ ...room, kind: "voice" }] }}
      socketState="live"
      roomHistory={{}}
      t={t}
      currentRoom={{ ...room, kind: "voice" }}
      activeVoiceRoomId={null}
      controls={createInitialVoiceControls()}
      visualTargets={empty}
      voiceSnapshots={{ [room.id]: { roomId: room.id, viewerInVoiceRoom: false, members: [selfMember, publisher] } }}
      musicQueues={{}}
      remoteStreams={empty}
      peerConnectionStates={{}}
      screenPlaybackStates={{}}
      localPreviews={empty}
      memberVolumes={{}}
      screenVolumes={{}}
      audioLevels={{ input: 100, output: 100 }}
      screenConnectionWarnings={{}}
      pendingLiveWatch={watchRequest}
      onJoinVoice={onJoinVoice}
      onSetVisualSubscriptions={onSetVisualSubscriptions}
      onRequestVoiceSnapshot={noop}
      onLiveWatchHandled={() => {
        calls.handled++;
      }}
      {...props}
    />
  );
}
function ChatProbe(props) {
  return (
    <TextRoomScreen
      user={account}
      language="en"
      timeFormat="24-hour"
      externalPreviews={{}}
      t={t}
      currentRoom={room}
      rooms={{ text: [room], voice: [] }}
      roomHistory={{}}
      activeServerId={room.serverId}
      serverMembers={empty}
      onlineUsers={empty}
      messages={empty}
      contextMessages={null}
      pinRevision={0}
      identityChanges={{}}
      canPin={false}
      outbox={empty}
      onSendMessage={noop}
      onNavigate={noop}
      onRetrySend={noop}
      onDiscardSend={noop}
      onOpenContext={resolved}
      onBackToLatest={resolved}
      onPin={resolved}
      onReact={resolved}
      onClearReactions={resolved}
      onUpdateMessage={resolved}
      onDeleteMessage={resolved}
      onSuppressEmbed={resolved}
      {...props}
    />
  );
}
const root = createRoot(document.getElementById("root"));
const probes = {
  session: SessionProbe,
  workspace: WorkspaceProbe,
  voice: VoiceProbe,
  audio: RemoteAudio,
  live: LiveProbe,
  chat: ChatProbe
};
let mode;
let properties;
window.hookFixture = {
  calls,
  capture,
  mount(nextMode, nextProperties = {}) {
    sessionStorage.clear();
    mode = nextMode;
    properties = nextProperties;
    this.update({});
  },
  update(patch) {
    properties = { ...properties, ...patch };
    flushSync(() => root.render(React.createElement(probes[mode], { ...properties, key: mode })));
  },
  unmount() {
    flushSync(() => root.render(null));
  },
  finishSession(status = 200) {
    finishSession(Response.json(status === 200 ? { user: account } : { error: "unauthorized" }, { status }));
  },
  finishLiveJoin() {
    finishLiveJoin(true);
  },
  finishLiveSelection() {
    finishLiveSelection();
  },
  inVoiceSnapshot: { [room.id]: { roomId: room.id, viewerInVoiceRoom: true, members: [selfMember, publisher] } },
  messages(count) {
    return Array.from({ length: count }, (_, index) => ({
      id: `message-${index}`,
      sequence: index,
      roomId: room.id,
      serverId: room.serverId,
      userId: "publisher",
      nickname: "Publisher",
      authorDeleted: false,
      body: `Message ${index}`,
      mentions: [],
      reactionState: { version: 0, reactions: [] },
      createdAt: "2026-01-01T12:00:00Z",
      editedAt: null,
      pinnedAt: null,
      suppressedEmbedKeys: [],
      replyToMessageId: null,
      replyTo: null
    }));
  }
};
