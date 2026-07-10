import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, MouseEvent, ReactNode } from "react";
import type {
  ChatMessage,
  PresenceUser,
  PublicUser,
  RoomSummary,
  VisualMediaKind,
  VisualTarget,
  VoiceMediaState,
  VoiceSetVisualSubscriptionsAck,
  VoiceSnapshot
} from "@voxly/shared";
import {
  acceptInvite,
  ApiError,
  banUser,
  claimOwnerSession,
  createInvite,
  deleteMessage,
  fetchConfig,
  fetchMe,
  fetchMessages,
  fetchOwnerData,
  fetchRooms,
  logout,
  revokeInvite,
  revokeSession,
  sendMessage,
  updateMessage
} from "./api.js";
import { createVoxlySocket, type VoxlySocket } from "./socket.js";
import type { AppConfigResponse, OwnerInvite, OwnerSession } from "./types.js";
import { controlPresentation, type VoiceControls } from "./lib/voiceControls.js";
import { getInviteTokenFromPath, getOwnerClaimTokenFromHash, parsePathRoute, resolveInitialRoute } from "./lib/navigation.js";
import { buildInviteUrl, inviteReference, resolveInviteOrigin } from "./lib/invites.js";
import { messageDeleteFailureCopy, messagePermissions } from "./lib/messages.js";
import { useVoiceMedia } from "./lib/useVoiceMedia.js";
import { replaceVisualTarget, toggleVisualTarget, visualTargetKey } from "./lib/voiceResume.js";
import { remoteStreamKey, type RemoteStreamState } from "./lib/voiceStreams.js";
import {
  DEFAULT_VOLUME_PERCENT,
  pruneVolumes,
  readUserVolumes,
  setVolume,
  volumeGain,
  writeUserVolumes
} from "./lib/voiceVolume.js";
import { loadTurnstile } from "./lib/turnstile.js";
import {
  languageLabel,
  readLanguageChoice,
  saveLanguageChoice,
  translate,
  type LanguageCode,
  type TranslationKey
} from "./lib/i18n.js";

type Route =
  | { name: "landing" }
  | { name: "invite"; token: string }
  | { name: "owner-claim"; token: string }
  | { name: "text"; roomId: string }
  | { name: "voice"; roomId: string }
  | { name: "owner" };

type LoadState = "loading" | "ready" | "error";
type ThemeChoice = "auto" | "light" | "dark";
type Drawer = "channels" | "members" | null;
type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

const themeKey = "voxly:theme";
const landingFeatureKeys = ["privateAccess", "lowFootprint", "selfHosted"] as const;

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [user, setUser] = useState<PublicUser | null>(null);
  const [authState, setAuthState] = useState<LoadState>("loading");
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, ChatMessage[]>>({});
  const [onlineUsers, setOnlineUsers] = useState<PresenceUser[]>([]);
  const [socketState, setSocketState] = useState<"connecting" | "live" | "reconnecting" | "offline">("connecting");
  const [socketInstance, setSocketInstance] = useState<VoxlySocket | null>(null);
  const [appConfig, setAppConfig] = useState<AppConfigResponse>({ publicUrl: null, rtc: { iceServers: [] }, turnstile: null });
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [theme, setTheme] = useState<ThemeChoice>(() => readThemeChoice());
  const [language, setLanguage] = useState<LanguageCode>(() => readLanguageChoice());
  const socketRef = useRef<VoxlySocket | null>(null);
  const t = useCallback<Translate>((key, values) => translate(language, key, values), [language]);
  const voiceRoomIds = useMemo(() => rooms.filter((room) => room.kind === "voice").map((room) => room.id), [rooms]);
  const voice = useVoiceMedia({ socket: socketInstance, user, iceServers: appConfig.rtc.iceServers, voiceRoomIds });
  const [memberVolumes, setMemberVolumes] = useState<Record<string, number>>({});
  const [screenVolumes, setScreenVolumes] = useState<Record<string, number>>({});

  useEffect(() => {
    setMemberVolumes(user ? readUserVolumes(user.id) : {});
  }, [user?.id]);

  useEffect(() => {
    const activeScreenIds = voice.remoteStreams
      .filter((item) => item.kind === "screen")
      .map((item) => item.stream.id);
    setScreenVolumes((current) => pruneVolumes(current, activeScreenIds));
  }, [voice.remoteStreams]);

  const changeMemberVolume = useCallback((remoteUserId: string, volume: number) => {
    if (!user) return;
    setMemberVolumes((current) => {
      const next = setVolume(current, remoteUserId, volume);
      writeUserVolumes(user.id, next);
      return next;
    });
  }, [user]);

  const changeScreenVolume = useCallback((streamId: string, volume: number) => {
    setScreenVolumes((current) => setVolume(current, streamId, volume));
  }, []);

  const navigate = useCallback((path: string) => {
    window.history.pushState(null, "", path);
    setRoute(parseRoute(path));
    setDrawer(null);
  }, []);

  const handleOwnerClaimed = useCallback((claimedUser: PublicUser) => {
    setUser(claimedUser);
    navigate("/owner");
  }, [navigate]);

  useEffect(() => {
    const handlePop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  }, []);

  useEffect(() => {
    applyThemeChoice(theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    let isMounted = true;
    fetchConfig()
      .then((config) => {
        if (isMounted) setAppConfig(config);
      })
      .catch(() => {
        if (isMounted) setAppConfig({ publicUrl: null, rtc: { iceServers: [] }, turnstile: null });
      });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    setAuthState("loading");
    fetchMe()
      .then((response) => {
        if (!isMounted) return;
        setUser(response.user);
        setAuthState("ready");
        if (window.location.pathname === "/" || route.name === "landing" || route.name === "invite") {
          navigate(resolveInitialRoute({ isAuthenticated: true, inviteToken: null }));
        }
      })
      .catch((error: unknown) => {
        if (!isMounted) return;
        if (error instanceof ApiError && error.status === 401) {
          setUser(null);
          setAuthState("ready");
          if (route.name !== "landing" && route.name !== "invite" && route.name !== "owner-claim") {
            navigate(resolveInitialRoute({ isAuthenticated: false, inviteToken: getInviteTokenFromPath(window.location.pathname) || null }));
          }
          return;
        }
        setAuthState("error");
      });

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!user) return;

    let isMounted = true;
    fetchRooms()
      .then((response) => {
        if (isMounted) {
          setRooms(response.rooms);
        }
      })
      .catch(() => {
        if (isMounted) setRooms([]);
      });

    return () => {
      isMounted = false;
    };
  }, [user]);

  useEffect(() => {
    if (!user || route.name !== "text") return;
    let isMounted = true;
    fetchMessages(route.roomId)
      .then((response) => {
        if (isMounted) {
          setMessagesByRoom((current) => ({ ...current, [route.roomId]: response.messages }));
        }
      })
      .catch(() => {
        if (isMounted) {
          setMessagesByRoom((current) => ({ ...current, [route.roomId]: [] }));
        }
      });

    return () => {
      isMounted = false;
    };
  }, [route, user]);

  useEffect(() => {
    if (!user) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setSocketInstance(null);
      setOnlineUsers([]);
      return;
    }

    const socket = createVoxlySocket();
    socketRef.current = socket;
    setSocketInstance(socket);
    setSocketState("connecting");

    socket.on("connect", () => setSocketState("live"));
    socket.io.on("reconnect_attempt", () => setSocketState("reconnecting"));
    socket.on("disconnect", () => setSocketState("offline"));
    socket.on("presence:snapshot", (users) => setOnlineUsers(includeCurrentPresence(users, user)));
    socket.on("presence:online", (presenceUser) => {
      setOnlineUsers((current) => upsertPresence(current, presenceUser, user));
    });
    socket.on("presence:offline", (userId) => {
      setOnlineUsers((current) => current.filter((item) => item.userId !== userId));
    });
    socket.on("message:new", (message) => {
      setMessagesByRoom((current) => ({
        ...current,
        [message.roomId]: upsertMessage(current[message.roomId] ?? [], message)
      }));
    });
    socket.on("message:updated", (message) => {
      setMessagesByRoom((current) => ({
        ...current,
        [message.roomId]: upsertMessage(current[message.roomId] ?? [], message)
      }));
    });
    socket.on("message:deleted", ({ roomId, messageId }) => {
      setMessagesByRoom((current) => ({
        ...current,
        [roomId]: (current[roomId] ?? []).filter((message) => message.id !== messageId)
      }));
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setSocketInstance(null);
    };
  }, [user]);

  useEffect(() => {
    if (!socketInstance || route.name !== "text") return;
    socketInstance.emit("room:join", route.roomId);
    return () => {
      socketInstance.emit("room:leave", route.roomId);
    };
  }, [route, socketInstance]);

  useEffect(() => {
    if (route.name === "voice") {
      voice.requestSnapshot(route.roomId);
    }
  }, [route, voice.requestSnapshot]);

  const roomGroups = useMemo(() => {
    return {
      text: rooms.filter((room) => room.kind === "text"),
      voice: rooms.filter((room) => room.kind === "voice")
    };
  }, [rooms]);

  const currentRoom = rooms.find((room) => {
    if (route.name === "text" || route.name === "voice") {
      return room.id === route.roomId;
    }
    return false;
  });

  if (authState === "loading") {
    return <LoadingScreen t={t} />;
  }

  if (authState === "error") {
    return <FatalState t={t} />;
  }

  if (route.name === "owner-claim") {
    return (
      <OwnerClaimScreen
        token={route.token}
        language={language}
        t={t}
        onLanguageChange={(nextLanguage) => {
          saveLanguageChoice(nextLanguage);
          setLanguage(nextLanguage);
        }}
        onClaimed={handleOwnerClaimed}
      />
    );
  }

  if (!user && route.name === "landing") {
    return (
      <LandingPage
        language={language}
        t={t}
        onNavigate={navigate}
        onLanguageChange={(nextLanguage) => {
          saveLanguageChoice(nextLanguage);
          setLanguage(nextLanguage);
        }}
      />
    );
  }

  if (!user && route.name === "invite" && !route.token) {
    return (
      <InviteRequiredScreen
        language={language}
        t={t}
        onNavigate={navigate}
        onLanguageChange={(nextLanguage) => {
          saveLanguageChoice(nextLanguage);
          setLanguage(nextLanguage);
        }}
      />
    );
  }

  if (!user || route.name === "invite") {
    return (
      <InviteScreen
        initialToken={route.name === "invite" ? route.token : ""}
        turnstileSiteKey={appConfig.turnstile?.siteKey ?? null}
        language={language}
        t={t}
        onLanguageChange={(nextLanguage) => {
          saveLanguageChoice(nextLanguage);
          setLanguage(nextLanguage);
        }}
        onAccepted={(acceptedUser) => {
          setUser(acceptedUser);
          navigate("/app/text/general");
        }}
      />
    );
  }

  const shellProps = {
    user,
    route,
    rooms: roomGroups,
    onlineUsers,
    socketState,
    activeVoiceRoomId: voice.activeRoomId,
    controls: voice.controls,
    drawer,
    theme,
    language,
    t,
    currentRoom,
    appConfig,
    voiceError: voice.error,
    visualTargets: voice.visualTargets,
    voiceSnapshots: voice.voiceSnapshots,
    remoteStreams: voice.remoteStreams,
    localPreviews: voice.localPreviews,
    memberVolumes,
    screenVolumes,
    onNavigate: navigate,
    onDrawerChange: setDrawer,
    onThemeChange: (nextTheme: ThemeChoice) => {
      saveThemeChoice(nextTheme);
      setTheme(nextTheme);
    },
    onLanguageChange: (nextLanguage: LanguageCode) => {
      saveLanguageChoice(nextLanguage);
      setLanguage(nextLanguage);
    },
    onJoinVoice: voice.join,
    onRequestVoiceSnapshot: voice.requestSnapshot,
    onSetVisualSubscriptions: voice.setVisualSubscriptions,
    onMemberVolumeChange: changeMemberVolume,
    onScreenVolumeChange: changeScreenVolume,
    onToggleControl: voice.toggleControl,
    onLeaveVoice: voice.leave,
    onLogout: async () => {
      voice.leave();
      await logout();
      setUser(null);
      navigate("/invite");
    }
  };

  if (route.name === "owner") {
    return <OwnerPanel {...shellProps} />;
  }

  if (route.name === "voice") {
    return <VoiceRoomScreen {...shellProps} />;
  }

  if (route.name !== "text") {
    return <LoadingScreen t={t} />;
  }

  return (
    <TextRoomScreen
      {...shellProps}
      messages={messagesByRoom[route.roomId] ?? []}
      onSendMessage={async (body) => {
        const response = await sendMessage(route.roomId, body);
        setMessagesByRoom((current) => ({
          ...current,
          [route.roomId]: upsertMessage(current[route.roomId] ?? [], response.message)
        }));
      }}
      onUpdateMessage={async (messageId, body) => {
        const response = await updateMessage(route.roomId, messageId, body);
        setMessagesByRoom((current) => ({
          ...current,
          [route.roomId]: upsertMessage(current[route.roomId] ?? [], response.message)
        }));
      }}
      onDeleteMessage={async (messageId) => {
        await deleteMessage(route.roomId, messageId);
        setMessagesByRoom((current) => ({
          ...current,
          [route.roomId]: (current[route.roomId] ?? []).filter((message) => message.id !== messageId)
        }));
      }}
    />
  );
}

function LandingPage({ language, t, onLanguageChange, onNavigate }: { language: LanguageCode; t: Translate; onLanguageChange: (language: LanguageCode) => void; onNavigate: (path: string) => void }) {
  useRevealOnScroll();

  return (
    <main className="landing-page">
      <header className="landing-nav" style={{ viewTransitionName: "persistent-nav" }}>
        <BrandLockup subtitle={t("landing.brandSubtitle")} href="/" onNavigate={onNavigate} />
        <nav className="landing-nav-actions" aria-label={t("landing.nav")}>
          <LanguageSwitch language={language} t={t} onLanguageChange={onLanguageChange} />
          <NavLink className="btn btn-ghost" href="/invite" onNavigate={onNavigate}>
            <span>{t("landing.haveInvite")}</span>
          </NavLink>
        </nav>
      </header>

      <section className="landing-hero reveal-block">
        <div className="landing-hero-copy">
          <p className="label">{t("landing.label")}</p>
          <h1>{t("landing.title")}</h1>
          <p className="landing-copy">{t("landing.copy")}</p>
          <div className="landing-actions">
            <NavLink className="btn btn-primary" href="/invite" onNavigate={onNavigate}>
              <ArrowIcon />
              <span>{t("landing.inviteCta")}</span>
            </NavLink>
          </div>
        </div>
        <div className="landing-signal" aria-hidden="true">
          <span className="landing-signal-ring landing-signal-ring-one" />
          <span className="landing-signal-ring landing-signal-ring-two" />
          <span className="landing-signal-ring landing-signal-ring-three" />
          <span className="landing-signal-core"><img src="/brand/logo-mark.svg" alt="" width="54" height="54" /></span>
        </div>
      </section>

      <section className="landing-points reveal-block" aria-label={t("landing.features")}>
        {landingFeatureKeys.map((key) => (
          <article className="landing-point" key={key}>
            <h2>{t(`landing.${key}.title` as TranslationKey)}</h2>
            <p>{t(`landing.${key}.copy` as TranslationKey)}</p>
          </article>
        ))}
      </section>
    </main>
  );
}

function useRevealOnScroll() {
  useEffect(() => {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>(".reveal-block"));
    if (!("IntersectionObserver" in window)) {
      blocks.forEach((block) => block.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.14 });

    blocks.forEach((block) => observer.observe(block));
    return () => observer.disconnect();
  }, []);
}

function InviteRequiredScreen({ language, t, onLanguageChange, onNavigate }: { language: LanguageCode; t: Translate; onLanguageChange: (language: LanguageCode) => void; onNavigate: (path: string) => void }) {
  return (
    <main className="invite-shell">
      <div className="invite-layout invite-layout-simple">
        <section className="invite-card">
          <BrandLockup subtitle={t("landing.brandSubtitle")} />
          <LanguageSwitch language={language} t={t} onLanguageChange={onLanguageChange} />
          <div>
            <p className="label">{t("invite.privateInvite")}</p>
            <h1>{t("invite.missingTitle")}</h1>
            <p className="muted small">{t("invite.missingCopy")}</p>
          </div>
          <div className="invite-status is-loading" aria-live="polite">
            <strong>{t("invite.linkRequired")}</strong>
            <span className="muted small">{t("invite.askOwner")}</span>
          </div>
          <NavLink className="btn btn-primary full-width" href="/" onNavigate={onNavigate}>
            <ArrowIcon />
            <span>{t("invite.backToHome")}</span>
          </NavLink>
        </section>
      </div>
    </main>
  );
}

interface ShellProps {
  user: PublicUser;
  route: Route;
  rooms: { text: RoomSummary[]; voice: RoomSummary[] };
  onlineUsers: PresenceUser[];
  socketState: "connecting" | "live" | "reconnecting" | "offline";
  activeVoiceRoomId: string | null;
  controls: VoiceControls;
  appConfig: AppConfigResponse;
  voiceError: string;
  visualTargets: VisualTarget[];
  voiceSnapshots: Record<string, VoiceSnapshot>;
  remoteStreams: RemoteStreamState[];
  localPreviews: Array<{ kind: "camera" | "screen"; stream: MediaStream }>;
  memberVolumes: Record<string, number>;
  screenVolumes: Record<string, number>;
  drawer: Drawer;
  theme: ThemeChoice;
  language: LanguageCode;
  t: Translate;
  currentRoom: RoomSummary | undefined;
  onNavigate: (path: string) => void;
  onDrawerChange: (drawer: Drawer) => void;
  onThemeChange: (theme: ThemeChoice) => void;
  onLanguageChange: (language: LanguageCode) => void;
  onJoinVoice: (roomId: string) => Promise<void>;
  onRequestVoiceSnapshot: (roomId: string) => void;
  onSetVisualSubscriptions: (targets: VisualTarget[]) => Promise<VoiceSetVisualSubscriptionsAck>;
  onMemberVolumeChange: (userId: string, volume: number) => void;
  onScreenVolumeChange: (streamId: string, volume: number) => void;
  onToggleControl: (key: keyof VoiceControls) => void;
  onLeaveVoice: () => void;
  onLogout: () => Promise<void>;
}

function TextRoomScreen(props: ShellProps & {
  messages: ChatMessage[];
  onSendMessage: (body: string) => Promise<void>;
  onUpdateMessage: (messageId: string, body: string) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [isSending, setIsSending] = useState(false);
  const listRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [props.messages.length]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) {
      setError(props.t("room.writeBeforeSending"));
      return;
    }

    setError("");
    setIsSending(true);
    try {
      await props.onSendMessage(body);
      setDraft("");
    } catch {
      setError(props.t("room.messageCouldNotSend"));
    } finally {
      setIsSending(false);
    }
  }

  return (
    <AppChrome {...props} mobileTitle={props.currentRoom?.name ?? "Text room"}>
      <main className="main-panel" id="main-content">
        <RoomHeader
          title={`#${props.currentRoom?.name ?? "lobby"}`}
          subtitle={props.t("room.generalTalk")}
          actionLabel={props.t("room.joinVoice")}
          onAction={() => props.onNavigate(`/app/voice/${props.rooms.voice[0]?.id ?? "lobby"}`)}
          t={props.t}
        />
        <section className="message-list" ref={listRef} aria-label={props.t("room.messages")}>
          <div className="message-day">{props.t("room.today")}</div>
          {props.messages.length === 0 ? (
            <EmptyState title={props.t("room.noMessages")} copy={props.t("room.noMessagesCopy")} />
          ) : (
            props.messages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                user={props.user}
                language={props.language}
                t={props.t}
                onUpdate={props.onUpdateMessage}
                onDelete={props.onDeleteMessage}
              />
            ))
          )}
        </section>
        <footer className="composer">
          <form onSubmit={submit}>
            <label className="form-field" htmlFor="messageInput">
              <span className="label">{props.t("room.messageLabel", { room: props.currentRoom?.name ?? "lobby" })}</span>
              <textarea
                className="textarea"
                id="messageInput"
                value={draft}
                name="message"
                placeholder={props.t("room.chatPlaceholder")}
                rows={1}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            <button className="btn btn-primary" type="submit" disabled={isSending}>
              <ArrowIcon />
              <span>{isSending ? props.t("common.sending") : props.t("common.send")}</span>
            </button>
          </form>
          <p className="error-text" aria-live="polite">{error}</p>
        </footer>
      </main>
    </AppChrome>
  );
}

interface StageSource {
  key: string;
  kind: VisualMediaKind;
  ownerId: string;
  ownerName: string;
  ownerIsLocal: boolean;
  stream: MediaStream | null;
  target: VisualTarget | null;
}

function VoiceRoomScreen(props: ShellProps) {
  const [localStageKeys, setLocalStageKeys] = useState<string[]>([]);
  const [focusedSourceKey, setFocusedSourceKey] = useState<string | null>(null);
  const [stageStatus, setStageStatus] = useState("");
  const viewedRoomId = props.currentRoom?.id ?? (props.route.name === "voice" ? props.route.roomId : props.activeVoiceRoomId);
  const snapshotMembers = viewedRoomId ? props.voiceSnapshots[viewedRoomId]?.members ?? [] : [];
  const participants = snapshotMembers.length > 0
    ? snapshotMembers.map((member) => member.user)
    : props.activeVoiceRoomId
      ? [presenceFromUser(props.user)]
      : [];
  const connectedCount = participants.length;
  const streamByKey = new Map(props.remoteStreams.map((item) => [remoteStreamKey(item.userId, item.kind), item.stream]));
  for (const preview of props.localPreviews) {
    streamByKey.set(remoteStreamKey(props.user.id, preview.kind), preview.stream);
  }
  const mediaByUser = new Map(snapshotMembers.map((member) => [member.user.userId, member.media]));
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
        target: participant.userId === props.user.id ? null : { publisherUserId: participant.userId, kind }
      }));
  });
  const selectedRemoteKeys = new Set(props.visualTargets.map(visualTargetKey));
  const selectedKeys = new Set([...selectedRemoteKeys, ...localStageKeys]);
  const stageSources = visualSources.filter((source) => selectedKeys.has(source.key));
  const focusedSource = stageSources.find((source) => source.key === focusedSourceKey) ?? stageSources[0] ?? null;
  const hasVoiceActivity = Boolean(props.activeVoiceRoomId || snapshotMembers.length > 0);

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

  return (
    <AppChrome {...props} mobileTitle={props.currentRoom?.name ?? props.t("room.lobbyVoice")}>
      <main className="main-panel" id="main-content">
        <RoomHeader
          title={props.currentRoom?.name ?? props.t("room.lobbyVoice")}
          subtitle={props.t("room.pushToMute", { count: connectedCount })}
          actionLabel={props.t("room.openChat")}
          onAction={() => props.onNavigate(`/app/text/${props.rooms.text[0]?.id ?? "general"}`)}
          t={props.t}
        />
        {hasVoiceActivity ? (
          <section className="call-surface voice-control-room" aria-label={props.t("room.voiceRooms")}>
            {stageSources.length > 0 ? (
              <VisualStage
                sources={stageSources}
                focusedSource={focusedSource}
                muted={props.controls.deafen.on}
                screenVolumes={props.screenVolumes}
                onFocus={setFocusedSourceKey}
                onScreenVolumeChange={props.onScreenVolumeChange}
                t={props.t}
              />
            ) : (
              <section className="stage-empty" aria-live="polite">
                <p className="label">{props.t("voice.stage")}</p>
                <strong>{props.t("voice.chooseSource")}</strong>
                <span>{props.t("voice.chooseSourceCopy")}</span>
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
                        <button className="visual-source-main" type="button" onClick={() => watchSource(source)} aria-pressed={selected}>
                          <span className="source-thumb" aria-hidden="true">
                            {source.stream ? <RemoteVideo stream={source.stream} muted /> : <span>{initial(source.ownerName)}</span>}
                          </span>
                          <span className="source-copy"><strong>{source.ownerName}</strong><span>{source.kind === "screen" ? props.t("status.screenSharing") : props.t("status.cameraOn")}</span></span>
                          <span className="source-watch">{props.t("voice.watch")}</span>
                        </button>
                        <button
                          className={`icon-btn source-multi-toggle ${selected ? "is-active" : ""}`}
                          type="button"
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

            <section className="voice-participants" aria-labelledby="participantTitle">
              <header className="compact-section-head"><div><p className="label" id="participantTitle">{props.t("common.members")}</p><span>{props.t("room.pushToMute", { count: connectedCount })}</span></div></header>
              <ul className="participant-list">
                {participants.map((participant) => {
                  const media = mediaFor(participant.userId);
                  const audioStream = participant.userId === props.user.id ? null : streamByKey.get(remoteStreamKey(participant.userId, "audio"));
                  const isSpeaking = Boolean(media?.speaking && media.mic && !media.deafened);
                  return (
                    <li className={`participant-row ${isSpeaking ? "is-speaking" : ""}`} key={participant.userId}>
                      {audioStream ? <RemoteAudio stream={audioStream} muted={props.controls.deafen.on} volume={props.memberVolumes[participant.userId] ?? DEFAULT_VOLUME_PERCENT} /> : null}
                      <span className="call-avatar" aria-hidden="true">{initial(participant.nickname)}</span>
                      <span className="participant-copy"><strong>{participant.nickname}</strong><VoiceStatusBadges media={media} t={props.t} /></span>
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
            <p className="voice-stage-status" aria-live="polite">{stageStatus}</p>
          </section>
        ) : (
          <section className="call-surface">
            <EmptyState title={props.t("room.noActiveVoice")} copy={props.t("room.noActiveVoiceCopy")} />
          </section>
        )}
      </main>
    </AppChrome>
  );
}

function OwnerPanel(props: ShellProps) {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [invites, setInvites] = useState<OwnerInvite[]>([]);
  const [sessions, setSessions] = useState<OwnerSession[]>([]);
  const [expiry, setExpiry] = useState(24);
  const [inviteLabel, setInviteLabel] = useState("");
  const [newInvite, setNewInvite] = useState<{ id: string; token: string; label: string } | null>(null);
  const [status, setStatus] = useState("");
  const newInviteUrl = newInvite ? buildInviteUrl(newInvite.token, resolveInviteOrigin(props.appConfig.publicUrl, window.location.origin)) : "";

  const reload = useCallback(async () => {
    const data = await fetchOwnerData();
    setUsers(data.users);
    setInvites(data.invites);
    setSessions(data.sessions);
  }, []);

  useEffect(() => {
    reload().catch(() => setStatus(props.t("owner.dataError")));
  }, [reload]);

  async function createNewInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const label = inviteLabel.trim();
    if (!label) {
      setStatus(props.t("owner.inviteLabelRequired"));
      return;
    }
    const response = await createInvite(label, expiry);
    setNewInvite({ id: response.invite.id, token: response.invite.token, label: response.invite.label });
    setInviteLabel("");
    setStatus(props.t("owner.created"));
    await reload();
  }

  return (
    <div className="owner-shell">
      <aside className="owner-nav">
        <BrandLockup subtitle={props.t("owner.panel")} href="/app/text/general" onNavigate={props.onNavigate} />
        <section className="rail-section">
          <a className="channel-item is-active" href="#invites"><span className="channel-prefix">01</span><span>{props.t("owner.invites")}</span><span /></a>
          <a className="channel-item" href="#users"><span className="channel-prefix">02</span><span>{props.t("common.users")}</span><span /></a>
          <a className="channel-item" href="#sessions"><span className="channel-prefix">03</span><span>{props.t("common.sessions")}</span><span /></a>
        </section>
        <section className="session-card">
          <span className="label">{props.t("owner.access")}</span>
          <MemberRow user={props.user.nickname} detail={props.t("owner.sessionDetail")} owner />
          <p className="muted small">{props.t("owner.normalViewCopy")}</p>
        </section>
      </aside>
      <main className="owner-main" id="main-content">
        <header className="owner-hero">
          <div>
            <p className="label">Voxly</p>
            <h1>{props.t("owner.title")}</h1>
            <p className="muted">{props.t("owner.heroCopy")}</p>
          </div>
          <NavLink className="btn" href="/app/text/general" onNavigate={props.onNavigate}>
            <ChatIcon />
            <span>{props.t("common.backToChat")}</span>
          </NavLink>
        </header>
        <section className="owner-grid" id="invites">
          <form className="owner-card" onSubmit={createNewInvite}>
            <div>
              <h2>{props.t("common.createInvite")}</h2>
              <p className="muted small">{props.t("owner.createCopy")}</p>
            </div>
            <label className="form-field" htmlFor="inviteLabel">
              <span>{props.t("owner.inviteLabel")}</span>
              <input className="input" id="inviteLabel" name="inviteLabel" value={inviteLabel} onChange={(event) => setInviteLabel(event.target.value)} placeholder={props.t("owner.inviteLabelPlaceholder")} maxLength={80} />
            </label>
            <label className="form-field" htmlFor="expiry">
              <span>{props.t("owner.expiresAfter")}</span>
              <select className="input" id="expiry" name="expiry" value={expiry} onChange={(event) => setExpiry(Number(event.target.value))}>
                <option value="2">2h</option>
                <option value="8">8h</option>
                <option value="24">24h</option>
                <option value="72">72h</option>
              </select>
            </label>
            <button className="btn btn-primary" type="submit">
              <PlusIcon />
              <span>{props.t("common.createInvite")}</span>
            </button>
            {newInviteUrl ? (
              <div className="invite-status is-valid">
                <strong>{props.t("owner.newInviteLink")}</strong>
                <span>{newInvite?.label}</span>
                <span className="mono">{newInviteUrl}</span>
                <span className="muted small">{props.t("owner.newInviteLinkCopy")}</span>
                <button className="btn btn-ghost" type="button" onClick={async () => {
                  try {
                    await navigator.clipboard?.writeText(newInviteUrl);
                    setStatus(props.t("owner.copied"));
                  } catch {
                    setStatus(props.t("owner.copyFailed"));
                  }
                }}>
                  <CopyIcon />
                  <span>{props.t("common.copy")}</span>
                </button>
              </div>
            ) : null}
          </form>
          <section className="table-card">
            <div className="table-head"><span>{props.t("owner.reference")}</span><span>{props.t("owner.uses")}</span><span>{props.t("common.expiry")}</span><span>{props.t("common.actions")}</span></div>
            {invites.map((invite) => (
              <div className="table-row" key={invite.id}>
                <span><strong>{invite.label || props.t("owner.unlabeledInvite")}</strong><br /><span className="mono muted small">{inviteReference(invite.id)}</span></span>
                <span>{invite.usedAt ? props.t("status.claimed") : invite.revokedAt ? props.t("status.revoked") : props.t("status.oneUseLeft")}</span>
                <span>{formatShortDate(invite.expiresAt, props.language, props.t)}</span>
                <span>
                  <button className="btn btn-danger" type="button" disabled={Boolean(invite.usedAt || invite.revokedAt)} onClick={async () => {
                    if (!window.confirm(props.t("owner.revokeConfirm"))) return;
                    try {
                      setStatus("");
                      await revokeInvite(invite.id);
                      await reload();
                    } catch {
                      setStatus(props.t("owner.revokeFailed"));
                    }
                  }}>
                    <TrashIcon />
                    <span>{props.t("common.revoke")}</span>
                  </button>
                </span>
              </div>
            ))}
          </section>
        </section>
        <section className="owner-grid" id="users">
          <section className="table-card">
            <div className="table-head"><span>{props.t("common.user")}</span><span>{props.t("common.role")}</span><span>{props.t("common.status")}</span><span>{props.t("common.actions")}</span></div>
            {users.map((item) => (
              <div className="table-row" key={item.id}>
                <span><MemberRow user={item.nickname} detail={item.role === "owner" ? props.t("shell.ownerSession") : props.t("shell.memberSession")} owner={item.role === "owner"} /></span>
                <span>{item.role === "owner" ? props.t("common.owner") : props.t("common.member")}</span>
                <span><StatusPill tone={item.bannedAt ? "danger" : "online"}>{item.bannedAt ? props.t("common.banned") : props.t("common.online")}</StatusPill></span>
                <span>
                  <button className="btn btn-danger" type="button" disabled={item.role === "owner" || Boolean(item.bannedAt)} onClick={async () => { if (!window.confirm(props.t("owner.banConfirm", { nickname: item.nickname }))) return; await banUser(item.id); await reload(); }}>
                    <ShieldIcon />
                    <span>{props.t("common.ban")}</span>
                  </button>
                </span>
              </div>
            ))}
          </section>
          <section className="owner-card">
            <h2>{props.t("owner.policyTitle")}</h2>
            <p className="muted">{props.t("owner.policyCopy")}</p>
            <div className="invite-status is-valid"><strong>{props.t("owner.normalView")}</strong><span className="muted small">{props.t("owner.normalViewCopy")}</span></div>
          </section>
        </section>
        <section className="table-card" id="sessions">
          <div className="table-head"><span>{props.t("common.session")}</span><span>{props.t("common.user")}</span><span>{props.t("common.state")}</span><span>{props.t("common.actions")}</span></div>
          {sessions.map((session) => (
            <div className="table-row" key={session.id}>
              <span className="mono">{session.id.slice(0, 8)}</span>
              <span>{session.nickname}</span>
              <span><StatusPill tone={session.revokedAt ? "danger" : "live"}>{session.revokedAt ? props.t("common.revoked") : props.t("common.active")}</StatusPill></span>
              <span>
                <button className="btn btn-danger" type="button" disabled={Boolean(session.revokedAt)} onClick={async () => { if (!window.confirm(props.t("owner.endSessionConfirm", { nickname: session.nickname }))) return; await revokeSession(session.id); await reload(); }}>
                  <LeaveIcon />
                  <span>{props.t("common.end")}</span>
                </button>
              </span>
            </div>
          ))}
        </section>
        <p className="error-text" aria-live="polite">{status}</p>
      </main>
    </div>
  );
}

function AppChrome(props: ShellProps & { children: ReactNode; mobileTitle: string }) {
  const onlineCount = props.onlineUsers.length || 1;
  const voiceConnectedCount = props.activeVoiceRoomId && props.voiceSnapshots[props.activeVoiceRoomId]
    ? props.voiceSnapshots[props.activeVoiceRoomId].members.length
    : props.activeVoiceRoomId
      ? 1
      : 0;
  return (
    <>
      <a className="skip-link" href="#main-content">{props.t("shell.skip")}</a>
      <div className={`drawer-scrim ${props.drawer ? "is-visible" : ""}`} onClick={() => props.onDrawerChange(null)} />
      <div className="mobile-topbar">
        <button className="icon-btn" type="button" onClick={() => props.onDrawerChange(props.drawer === "channels" ? null : "channels")} aria-label={props.t("common.rooms")}>
          <MenuIcon />
          <span>{props.t("common.rooms")}</span>
        </button>
        <BrandLockup title={props.mobileTitle} subtitle={props.t("common.connected", { count: onlineCount })} href="/app/text/general" onNavigate={props.onNavigate} />
        <button className="icon-btn" type="button" onClick={() => props.onDrawerChange(props.drawer === "members" ? null : "members")} aria-label={props.t("common.users")}>
          <UsersIcon />
          <span>{props.t("common.users")}</span>
        </button>
      </div>
      <div className={`app-shell drawer-${props.drawer ?? "none"}`}>
        <ChannelRail {...props} />
        {props.children}
        <MemberPanel users={props.onlineUsers} activeVoiceRoomId={props.activeVoiceRoomId} t={props.t} />
      </div>
      <VoiceDock {...props} connectedCount={voiceConnectedCount} />
      <Toast message={props.voiceError} />
    </>
  );
}

function ChannelRail(props: ShellProps) {
  return (
    <aside className="rail">
      <BrandLockup href="/app/text/general" onNavigate={props.onNavigate} />
      <section className="rail-section">
        <div className="rail-section-head"><span className="label">{props.t("room.textRooms")}</span><span className="badge">{props.rooms.text.length}</span></div>
        {props.rooms.text.map((room) => (
          <NavLink className={`channel-item ${props.route.name === "text" && props.route.roomId === room.id ? "is-active" : ""}`} href={`/app/text/${room.id}`} key={room.id} onNavigate={props.onNavigate}>
            <span className="channel-prefix">#</span><span>{room.name}</span><span className="badge">0</span>
          </NavLink>
        ))}
      </section>
      <section className="rail-section">
        <div className="rail-section-head"><span className="label">{props.t("room.voiceRooms")}</span><span className="badge">{props.rooms.voice.length}</span></div>
        {props.rooms.voice.map((room) => {
          const members = voiceMembersForRoom(props, room.id);
          return (
            <div className="voice-channel-block" key={room.id}>
              <NavLink className={`channel-item ${props.route.name === "voice" && props.route.roomId === room.id ? "is-active" : ""}`} href={`/app/voice/${room.id}`} onNavigate={props.onNavigate}>
                <span className="channel-prefix">vc</span><span>{room.name}</span><span className="badge">{members.length}</span>
              </NavLink>
              {members.length > 0 ? (
                <div className="voice-channel-users">
                  {members.map((member) => (
                    <span className={`voice-channel-user ${member.media.speaking && member.media.mic && !member.media.deafened ? "is-speaking" : ""}`} key={member.user.userId}>
                      <span className="avatar">{initial(member.user.nickname)}</span>
                      <span className="voice-channel-user-copy">
                        <span>{member.user.nickname}</span>
                        <VoiceStatusBadges media={member.media} t={props.t} compact />
                      </span>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </section>
      <PreferencesCard
        language={props.language}
        theme={props.theme}
        t={props.t}
        onLanguageChange={props.onLanguageChange}
        onThemeChange={props.onThemeChange}
      />
    </aside>
  );
}

function MemberPanel({ users, activeVoiceRoomId, t }: { users: PresenceUser[]; activeVoiceRoomId: string | null; t: Translate }) {
  return (
    <aside className="member-panel">
      <section className="member-section">
        <div className="member-section-head"><span className="label">{t("common.online")}</span><span className="badge">{users.length}</span></div>
        {users.length === 0 ? (
          <p className="muted small">{t("room.presenceWaiting")}</p>
        ) : (
          users.map((user, index) => (
            <div className="member-row" key={user.userId}>
              <span className={`avatar ${user.role === "owner" ? "owner" : ""}`}>{initial(user.nickname)}</span>
              <span className="member-copy"><strong>{user.nickname}</strong><span>{activeVoiceRoomId && index === 0 ? t("room.inLobby") : t("common.online")}</span></span>
            </div>
          ))
        )}
      </section>
    </aside>
  );
}

function RoomHeader({ title, subtitle, actionLabel, onAction }: { title: string; subtitle: string; actionLabel: string; onAction: () => void; t: Translate }) {
  return (
    <header className="room-header">
      <div className="room-title"><strong>{title}</strong><span className="muted small">{subtitle}</span></div>
      <div className="room-actions">
        <button className="btn btn-ghost" type="button" onClick={onAction}><ChatIcon /><span>{actionLabel}</span></button>
      </div>
    </header>
  );
}

function VoiceDock(props: ShellProps & { connectedCount: number }) {
  const roomName = props.activeVoiceRoomId ? props.t("room.lobbyVoice") : props.t("common.offline");
  const canJoinCurrentVoice = !props.activeVoiceRoomId && props.route.name === "voice";
  const micControl = controlPresentation("mic", props.controls);
  const deafenControl = controlPresentation("deafen", props.controls);
  const cameraControl = controlPresentation("camera", props.controls);
  const screenControl = controlPresentation("screenShare", props.controls);
  return (
    <footer className="voice-dock">
      <div className="dock-room">
        <span className={`status-dot ${props.socketState === "live" ? "online" : props.socketState === "offline" ? "danger" : "warn"}`} />
        <span className="dock-status"><strong>{roomName}</strong><span className="muted small">{props.activeVoiceRoomId ? `${voiceDockStatusLabel(props.controls, props.connectedCount, props.t)} · ${connectionLabel(props.socketState, props.t)}` : connectionCopy(props.socketState, props.t)}</span></span>
      </div>
      <div className="dock-controls">
        {canJoinCurrentVoice ? (
          <button className="btn btn-primary" type="button" onClick={() => props.onJoinVoice(props.currentRoom?.id ?? "lobby")}><HeadsetIcon off={false} /><span>{props.t("room.joinCurrentVoice")}</span></button>
        ) : null}
        {props.activeVoiceRoomId ? (
          <>
            <ControlButton label={props.t(`common.${micControl.action}` as TranslationKey)} active={props.controls.mic.on} tone={micControl.tone} enabled={props.controls.mic.enabled} onClick={() => props.onToggleControl("mic")}><MicIcon off={!props.controls.mic.on} /></ControlButton>
            <ControlButton label={props.t(`common.${deafenControl.action}` as TranslationKey)} active={props.controls.deafen.on} tone={deafenControl.tone} enabled={props.controls.deafen.enabled} onClick={() => props.onToggleControl("deafen")}><HeadsetIcon off={props.controls.deafen.on} /></ControlButton>
            <ControlButton label={props.t(`common.${cameraControl.action}` as TranslationKey)} active={props.controls.camera.on} tone={cameraControl.tone} enabled={props.controls.camera.enabled} onClick={() => props.onToggleControl("camera")}><CameraIcon off={!props.controls.camera.on} /></ControlButton>
            <ControlButton label={props.t(`common.${screenControl.action}` as TranslationKey)} active={props.controls.screenShare.on} tone={screenControl.tone} enabled={props.controls.screenShare.enabled} onClick={() => props.onToggleControl("screenShare")}><ScreenIcon off={props.controls.screenShare.on} /></ControlButton>
            <button className="btn btn-danger" type="button" onClick={props.onLeaveVoice}><LeaveIcon /><span>{props.t("common.leave")}</span></button>
          </>
        ) : null}
      </div>
      <div className="dock-self">
        {props.user.role === "owner" ? (
          <NavLink className="btn btn-ghost" href="/owner" onNavigate={props.onNavigate}><ShieldIcon /><span>{props.t("owner.panel")}</span></NavLink>
        ) : null}
        <button className="btn btn-ghost" type="button" onClick={props.onLogout}>{props.t("common.logout")}</button>
        <span className={`avatar ${props.user.role === "owner" ? "owner" : ""}`} title={props.user.nickname}>{initial(props.user.nickname)}</span>
      </div>
    </footer>
  );
}

function InviteScreen({ initialToken, turnstileSiteKey, onAccepted, language, t, onLanguageChange }: { initialToken: string; turnstileSiteKey: string | null; onAccepted: (user: PublicUser) => void; language: LanguageCode; t: Translate; onLanguageChange: (language: LanguageCode) => void }) {
  const [inviteToken, setInviteToken] = useState(initialToken);
  const [nickname, setNickname] = useState("");
  const [status, setStatus] = useState<"ready" | "loading" | "valid" | "danger">("ready");
  const [fieldError, setFieldError] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const onTurnstileToken = useCallback((token: string) => {
    setTurnstileToken(token);
    setFieldError("");
  }, []);
  const onTurnstileUnavailable = useCallback(() => {
    setTurnstileToken("");
    setFieldError(t("invite.turnstileUnavailable"));
  }, [t]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!nickname.trim()) {
      setFieldError(t("invite.chooseNicknameError"));
      return;
    }
    if (!inviteToken.trim()) {
      setFieldError(t("invite.pasteError"));
      return;
    }
    if (turnstileSiteKey && !turnstileToken) {
      setFieldError(t("invite.turnstileRequired"));
      return;
    }

    setFieldError("");
    setStatus("loading");
    try {
      const response = await acceptInvite(extractInviteToken(inviteToken), nickname.trim(), turnstileToken || undefined);
      setStatus("valid");
      onAccepted(response.user);
    } catch (error: unknown) {
      setStatus("danger");
      if (turnstileSiteKey) {
        setTurnstileToken("");
        setTurnstileResetKey((current) => current + 1);
      }
      if (error instanceof ApiError && error.code === "turnstile_failed") {
        setFieldError(t("invite.turnstileFailed"));
      }
    }
  }

  return (
    <main className="invite-shell">
      <div className="invite-layout invite-layout-simple">
        <section className="invite-card">
          <BrandLockup subtitle={t("landing.brandSubtitle")} />
          <LanguageSwitch language={language} t={t} onLanguageChange={onLanguageChange} />
          <div>
            <p className="label">{t("invite.privateInvite")}</p>
            <h1>{t("invite.joinTitle")}</h1>
            <p className="muted small">{t("invite.chooseName")}</p>
          </div>
          <div className={`invite-status ${statusClass(status)}`} aria-live="polite">
            <strong>{inviteStatusTitle(status, t)}</strong>
            <span className="muted small">{status === "danger" ? t("invite.askOwner") : t("invite.oneUseLeft")}</span>
          </div>
          <form onSubmit={submit}>
            <label className="form-field" htmlFor="inviteLink">
              <span>{t("invite.codeLabel")}</span>
              <input className="input" id="inviteLink" name="inviteLink" value={inviteToken} onChange={(event) => setInviteToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="VX-7K2M…" />
            </label>
            <label className="form-field field-gap" htmlFor="nickname">
              <span>{t("invite.nickname")}</span>
              <input className="input" id="nickname" name="nickname" value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="Wren…" autoComplete="nickname" />
            </label>
            {turnstileSiteKey ? (
              <div className="form-field field-gap">
                <span>{t("invite.humanCheck")}</span>
                <TurnstileWidget
                  siteKey={turnstileSiteKey}
                  resetKey={turnstileResetKey}
                  onToken={onTurnstileToken}
                  onUnavailable={onTurnstileUnavailable}
                />
              </div>
            ) : null}
            <p className="error-text" aria-live="polite">{fieldError}</p>
            <button className="btn btn-primary full-width" type="submit" disabled={status === "loading"}><ArrowIcon /><span>{status === "loading" ? t("common.checking") : t("invite.join")}</span></button>
          </form>
        </section>
      </div>
    </main>
  );
}

function TurnstileWidget({ siteKey, resetKey, onToken, onUnavailable }: { siteKey: string; resetKey: number; onToken: (token: string) => void; onUnavailable: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let isActive = true;
    let widgetId: string | null = null;
    onToken("");

    loadTurnstile()
      .then((turnstile) => {
        if (!isActive || !containerRef.current) return;
        widgetId = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme: "auto",
          callback: (token) => {
            if (isActive) onToken(token);
          },
          "expired-callback": () => {
            if (isActive) onToken("");
          },
          "error-callback": () => {
            if (isActive) onUnavailable();
          }
        });
      })
      .catch(() => {
        if (isActive) onUnavailable();
      });

    return () => {
      isActive = false;
      if (widgetId && window.turnstile) {
        window.turnstile.remove(widgetId);
      }
    };
  }, [onToken, onUnavailable, resetKey, siteKey]);

  return <div className="turnstile-widget" ref={containerRef} />;
}

function OwnerClaimScreen({ token, language, t, onLanguageChange, onClaimed }: { token: string; language: LanguageCode; t: Translate; onLanguageChange: (language: LanguageCode) => void; onClaimed: (user: PublicUser) => void }) {
  const [status, setStatus] = useState<"loading" | "danger">("loading");

  useEffect(() => {
    let isMounted = true;
    if (!token) {
      setStatus("danger");
      return;
    }

    claimOwnerSession(token)
      .then((response) => {
        if (isMounted) {
          onClaimed(response.user);
        }
      })
      .catch(() => {
        if (isMounted) {
          setStatus("danger");
        }
      });

    return () => {
      isMounted = false;
    };
  }, [onClaimed, token]);

  return (
    <main className="invite-shell">
      <div className="invite-layout invite-layout-simple">
        <section className="invite-card">
          <BrandLockup subtitle="Owner setup" />
          <LanguageSwitch language={language} t={t} onLanguageChange={onLanguageChange} />
          <div>
            <p className="label">{t("ownerClaim.label")}</p>
            <h1>{t("ownerClaim.title")}</h1>
            <p className="muted small">{t("ownerClaim.copy")}</p>
          </div>
          <div className={`invite-status ${status === "danger" ? "is-danger" : "is-loading"}`} aria-live="polite">
            <strong>{status === "danger" ? t("ownerClaim.invalid") : t("ownerClaim.checking")}</strong>
            <span className="muted small">{status === "danger" ? t("ownerClaim.invalidCopy") : t("ownerClaim.checkingCopy")}</span>
          </div>
        </section>
      </div>
    </main>
  );
}

function MessageItem({
  message,
  user,
  language,
  t,
  onUpdate,
  onDelete
}: {
  message: ChatMessage;
  user: PublicUser;
  language: LanguageCode;
  t: Translate;
  onUpdate: (messageId: string, body: string) => Promise<void>;
  onDelete: (messageId: string) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [isBusy, setIsBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const permissions = messagePermissions({
    currentUserId: user.id,
    currentUserRole: user.role,
    messageUserId: message.userId
  });
  const isOwn = message.userId === user.id;

  async function saveEdit() {
    const body = draft.trim();
    if (!body) return;
    setIsBusy(true);
    setActionError("");
    try {
      await onUpdate(message.id, body);
      setIsEditing(false);
    } catch {
      setActionError(t("room.messageCouldNotSend"));
    } finally {
      setIsBusy(false);
    }
  }

  async function deleteCurrentMessage() {
    if (!window.confirm(t("room.deleteMessageConfirm"))) return;
    setIsBusy(true);
    setActionError("");
    try {
      await onDelete(message.id);
    } catch (error) {
      setActionError(messageDeleteFailureCopy(error instanceof ApiError ? error.status : undefined, t));
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <article className={`message ${isOwn ? "message-own" : ""}`}>
      <span className={`avatar ${isOwn ? "owner" : ""}`}>{initial(message.nickname)}</span>
      <div className="message-content">
        <div className="message-meta">
          <span className="message-author">{message.nickname}</span>
          <span className="message-time mono">{formatTime(message.createdAt, language)}{message.editedAt ? ` - ${t("status.edited")}` : ""}</span>
        </div>
        {isEditing ? (
          <div className="message-edit">
            <textarea className="textarea" value={draft} rows={2} onChange={(event) => setDraft(event.target.value)} />
            <div className="message-actions">
              <button className="btn btn-primary" type="button" disabled={isBusy} onClick={saveEdit}>{t("common.save")}</button>
              <button className="btn btn-ghost" type="button" disabled={isBusy} onClick={() => { setDraft(message.body); setIsEditing(false); }}>{t("common.cancel")}</button>
            </div>
          </div>
        ) : (
          <div className="message-body">{message.body}</div>
        )}
        {!isEditing && (permissions.canEdit || permissions.canDelete) ? (
          <div className="message-actions">
            {permissions.canEdit ? <button className="btn btn-ghost" type="button" disabled={isBusy} onClick={() => setIsEditing(true)}>{t("common.edit")}</button> : null}
            {permissions.canDelete ? <button className="btn btn-danger" type="button" disabled={isBusy} onClick={deleteCurrentMessage}>{t("common.delete")}</button> : null}
          </div>
        ) : null}
        {actionError ? <p className="error-text" aria-live="polite">{actionError}</p> : null}
      </div>
    </article>
  );
}

function PreferencesCard({
  language,
  theme,
  t,
  onLanguageChange,
  onThemeChange
}: {
  language: LanguageCode;
  theme: ThemeChoice;
  t: Translate;
  onLanguageChange: (language: LanguageCode) => void;
  onThemeChange: (theme: ThemeChoice) => void;
}) {
  return (
    <section className="theme-card">
      <div className="theme-card-head"><span className="label">{t("common.appearance")}</span><span className="small muted">{themeLabel(theme, t)}</span></div>
      <div className="theme-options" role="group" aria-label={t("common.appearance")}>
        {(["auto", "light", "dark"] as const).map((option) => (
          <button className="theme-option" type="button" key={option} aria-pressed={theme === option} onClick={() => onThemeChange(option)}>{themeLabel(option, t)}</button>
        ))}
      </div>
      <LanguageSwitch language={language} t={t} onLanguageChange={onLanguageChange} />
    </section>
  );
}

function LanguageSwitch({ language, t, onLanguageChange }: { language: LanguageCode; t: Translate; onLanguageChange: (language: LanguageCode) => void }) {
  return (
    <div className="language-switch">
      <div className="theme-card-head"><span className="label">{t("common.language")}</span></div>
      <div className="theme-options theme-options-compact" role="group" aria-label={t("common.language")}>
        {(["en", "tr"] as const).map((option) => (
          <button className="theme-option" type="button" key={option} aria-pressed={language === option} onClick={() => onLanguageChange(option)}>{languageLabel(option)}</button>
        ))}
      </div>
    </div>
  );
}

function ControlButton({ label, active, tone, enabled, onClick, children }: { label: string; active: boolean; tone: "neutral" | "danger"; enabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button className={`icon-btn control-icon ${active ? "is-active" : "is-off"} ${tone === "danger" ? "is-danger-state" : ""}`} type="button" aria-pressed={active} aria-label={label} title={label} disabled={!enabled} onClick={onClick}>
      {children}
    </button>
  );
}

function Toast({ message }: { message: string }) {
  const [visibleMessage, setVisibleMessage] = useState("");

  useEffect(() => {
    if (!message) return;
    setVisibleMessage(message);
    const timeout = window.setTimeout(() => setVisibleMessage(""), 4200);
    return () => window.clearTimeout(timeout);
  }, [message]);

  return visibleMessage ? <div className="toast toast-danger" role="alert">{visibleMessage}</div> : null;
}

function VoiceStatusBadges({ media, t, compact = false }: { media: VoiceMediaState | undefined; t: Translate; compact?: boolean }) {
  const items = voiceStatusItems(media, t);
  if (items.length === 0) {
    return <span className="small muted">{mediaLabel(media, t)}</span>;
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

function RemoteVideo({ stream, muted = false }: { stream: MediaStream; muted?: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);
  return <video className="call-video" ref={videoRef} autoPlay playsInline muted={muted} />;
}

function VolumeControl({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="volume-control">
      <span className="volume-control-label"><VolumeIcon /><span>{label}</span><strong>{value}%</strong></span>
      <input
        aria-label={label}
        type="range"
        min="0"
        max="200"
        step="1"
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function RemoteAudio({ stream, muted, volume }: { stream: MediaStream; muted: boolean; volume: number }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const [useFallback, setUseFallback] = useState(true);

  useEffect(() => {
    if (stream.getAudioTracks().length === 0) {
      setUseFallback(false);
      return;
    }

    // Keep the native output mounted until Web Audio has actually reached a
    // running state; a suspended context can otherwise make a new peer silent.
    setUseFallback(true);

    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) {
      setUseFallback(true);
      return;
    }

    try {
      const context = new AudioContextClass();
      const source = context.createMediaStreamSource(stream);
      const gain = context.createGain();
      source.connect(gain).connect(context.destination);
      contextRef.current = context;
      gainRef.current = gain;
      let isDisposed = false;
      const resumeContext = () => {
        void context.resume()
          .then(() => {
            if (!isDisposed) setUseFallback(false);
          })
          .catch(() => {
            if (!isDisposed) setUseFallback(true);
          });
      };
      resumeContext();
      window.addEventListener("pointerdown", resumeContext);
      window.addEventListener("keydown", resumeContext);

      return () => {
        isDisposed = true;
        window.removeEventListener("pointerdown", resumeContext);
        window.removeEventListener("keydown", resumeContext);
        source.disconnect();
        gain.disconnect();
        gainRef.current = null;
        contextRef.current = null;
        void context.close().catch(() => undefined);
      };
    } catch {
      setUseFallback(true);
    }
  }, [stream]);

  useEffect(() => {
    const gain = gainRef.current;
    if (!gain) return;
    gain.gain.value = muted ? 0 : volumeGain(volume);
    void contextRef.current?.resume().catch(() => setUseFallback(true));
  }, [muted, volume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const playFallback = () => {
      audio.srcObject = stream;
      audio.volume = Math.min(1, volumeGain(volume));
      audio.muted = muted;
      void audio.play().catch(() => undefined);
    };
    playFallback();
    window.addEventListener("pointerdown", playFallback);
    window.addEventListener("keydown", playFallback);
    return () => {
      window.removeEventListener("pointerdown", playFallback);
      window.removeEventListener("keydown", playFallback);
    };
  }, [muted, stream, useFallback, volume]);

  if (!useFallback) return null;
  return <audio className="remote-audio" ref={audioRef} autoPlay muted={muted} />;
}

function VisualStage({
  sources,
  focusedSource,
  muted,
  screenVolumes,
  onFocus,
  onScreenVolumeChange,
  t
}: {
  sources: StageSource[];
  focusedSource: StageSource | null;
  muted: boolean;
  screenVolumes: Record<string, number>;
  onFocus: (key: string) => void;
  onScreenVolumeChange: (streamId: string, volume: number) => void;
  t: Translate;
}) {
  const focusedElementRef = useRef<HTMLButtonElement | null>(null);
  const orderedSources = focusedSource
    ? [focusedSource, ...sources.filter((source) => source.key !== focusedSource.key)]
    : sources;
  const focusedStream = focusedSource?.stream ?? null;
  const focusedHasAudio = Boolean(focusedSource?.kind === "screen" && focusedStream?.getAudioTracks().length);
  const focusedVolume = focusedStream ? screenVolumes[focusedStream.id] ?? DEFAULT_VOLUME_PERCENT : DEFAULT_VOLUME_PERCENT;

  return (
    <section className={`screen-stage stage-count-${Math.min(orderedSources.length, 4)}`} aria-label={t("voice.stage")}>
      <div className="stage-grid">
        {orderedSources.map((source) => (
          <button
            className={`stage-media ${source.key === focusedSource?.key ? "is-focused" : ""}`}
            type="button"
            key={source.key}
            ref={(element) => {
              if (source.key === focusedSource?.key) focusedElementRef.current = element;
            }}
            onClick={() => onFocus(source.key)}
            aria-pressed={source.key === focusedSource?.key}
            aria-label={`${source.ownerName} ${source.kind === "screen" ? t("status.screenSharing") : t("status.cameraOn")}`}
          >
            {source.stream ? <RemoteVideo stream={source.stream} muted /> : <span className="screen-stage-placeholder">{source.ownerName}</span>}
            <span className="stage-media-label"><strong>{source.ownerName}</strong><span>{source.kind === "screen" ? t("status.screenSharing") : t("status.cameraOn")}</span></span>
          </button>
        ))}
      </div>
      {!focusedSource?.ownerIsLocal && focusedSource?.kind === "screen" && focusedStream && focusedHasAudio ? <RemoteAudio stream={focusedStream} muted={muted} volume={focusedVolume} /> : null}
      <div className="screen-stage-bar">
        <span><strong>{focusedSource?.ownerName}</strong><span className="muted small">{focusedSource?.kind === "screen" ? t("status.screenSharing") : t("status.cameraOn")}</span></span>
        {!focusedSource?.ownerIsLocal && focusedSource?.kind === "screen" ? (
          focusedHasAudio && focusedStream
            ? <details className="volume-popover stage-volume"><summary aria-label={t("voice.screenVolume")}><VolumeIcon /></summary><VolumeControl label={t("voice.screenVolume")} value={focusedVolume} onChange={(volume) => onScreenVolumeChange(focusedStream.id, volume)} /></details>
            : <span className="muted small">{t("voice.noScreenAudio")}</span>
        ) : null}
        <button className="icon-btn" type="button" onClick={() => focusedElementRef.current?.requestFullscreen?.()} aria-label={t("common.fullscreen")}>
          <MaximizeIcon />
          <span>{t("common.fullscreen")}</span>
        </button>
      </div>
    </section>
  );
}

function StatusPill({ tone, children }: { tone: "live" | "online" | "warn" | "danger"; children: ReactNode }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function MemberRow({ user, detail, owner }: { user: string; detail: string; owner?: boolean }) {
  return (
    <span className="member-row">
      <span className={`avatar ${owner ? "owner" : ""}`}>{initial(user)}</span>
      <span className="member-copy"><strong>{user}</strong><span>{detail}</span></span>
    </span>
  );
}

function BrandLockup({ title = "Voxly", subtitle = "The Basement", href = "/", onNavigate, onClick }: { title?: string; subtitle?: string; href?: string; onNavigate?: (path: string) => void; onClick?: () => void }) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (onNavigate) {
      linkHandler(href, onNavigate)(event);
      return;
    }
    if (onClick) {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <a className="brand-lockup brand-button" href={href} onClick={handleClick}>
      <span className="brand-mark"><img src="/brand/logo-mark.svg" alt="" /></span>
      <span className="brand-copy"><strong>{title}</strong><span>{subtitle}</span></span>
    </a>
  );
}

function NavLink({ href, className, onNavigate, children }: { href: string; className: string; onNavigate: (path: string) => void; children: ReactNode }) {
  return <a className={className} href={href} onClick={linkHandler(href, onNavigate)}>{children}</a>;
}

function linkHandler(href: string, onNavigate: (path: string) => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    onNavigate(href);
  };
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return <div className="empty-state"><h3>{title}</h3><p className="muted">{copy}</p></div>;
}

function LoadingScreen({ t }: { t: Translate }) {
  return <main className="invite-shell"><section className="invite-card"><BrandLockup /><div className="invite-status is-loading"><strong>{t("system.loadingVoxly")}</strong><span className="muted small">{t("system.checkingSession")}</span></div></section></main>;
}

function FatalState({ t }: { t: Translate }) {
  return <main className="invite-shell"><section className="invite-card"><BrandLockup /><div className="invite-status is-danger"><strong>{t("system.couldNotStart")}</strong><span className="muted small">{t("system.checkBackend")}</span></div></section></main>;
}

function parseRoute(pathname: string): Route {
  const route = parsePathRoute(pathname);
  if (route.name === "owner-claim") return { name: "owner-claim", token: getOwnerClaimTokenFromHash(window.location.hash) };
  return route;
}

function readThemeChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(themeKey);
    return value === "light" || value === "dark" ? value : "auto";
  } catch {
    return "auto";
  }
}

function saveThemeChoice(theme: ThemeChoice) {
  try {
    if (theme === "auto") localStorage.removeItem(themeKey);
    else localStorage.setItem(themeKey, theme);
  } catch {
    return;
  }
}

function applyThemeChoice(theme: ThemeChoice) {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

function includeCurrentPresence(users: PresenceUser[], user: PublicUser) {
  return upsertPresence(users, presenceFromUser(user), user);
}

function upsertPresence(users: PresenceUser[], next: PresenceUser, currentUser: PublicUser) {
  const withCurrent = users.some((item) => item.userId === currentUser.id) ? users : [presenceFromUser(currentUser), ...users];
  return withCurrent.some((item) => item.userId === next.userId)
    ? withCurrent.map((item) => (item.userId === next.userId ? next : item))
    : [...withCurrent, next];
}

function presenceFromUser(user: PublicUser): PresenceUser {
  return { userId: user.id, nickname: user.nickname, role: user.role };
}

function connectionLabel(state: ShellProps["socketState"], t: Translate) {
  if (state === "live") return t("connection.live");
  if (state === "reconnecting") return t("connection.reconnecting");
  if (state === "offline") return t("connection.offline");
  return t("connection.connecting");
}

function connectionCopy(state: ShellProps["socketState"], t: Translate) {
  if (state === "live") return t("connection.liveCopy");
  if (state === "reconnecting") return t("connection.reconnectingCopy");
  if (state === "offline") return t("connection.offlineCopy");
  return t("connection.connectingCopy");
}

function statusClass(status: "ready" | "loading" | "valid" | "danger") {
  if (status === "loading") return "is-loading";
  if (status === "danger") return "is-danger";
  return "is-valid";
}

function inviteStatusTitle(status: "ready" | "loading" | "valid" | "danger", t: Translate) {
  if (status === "loading") return t("invite.checking");
  if (status === "danger") return t("invite.unavailable");
  if (status === "valid") return t("invite.accepted");
  return t("invite.ready");
}

function extractInviteToken(value: string) {
  const trimmed = value.trim();
  const slashIndex = trimmed.lastIndexOf("/");
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

function formatTime(value: string, language: LanguageCode) {
  return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatShortDate(value: string | null, language: LanguageCode, t: Translate) {
  if (!value) return t("common.noExpiry");
  return new Intl.DateTimeFormat(language, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function themeLabel(theme: ThemeChoice, t: Translate) {
  if (theme === "light") return t("common.light");
  if (theme === "dark") return t("common.dark");
  return t("common.auto");
}

function voiceDockStatusLabel(controls: VoiceControls, connectedCount: number, t: Translate) {
  if (controls.deafen.on) {
    return t("status.deafenedOutputOff");
  }

  if (!controls.mic.on) {
    return t("status.micMuted", { count: connectedCount });
  }

  return t("common.connected", { count: connectedCount });
}

function mediaLabel(media: VoiceMediaState | undefined, t: Translate) {
  if (!media) return t("common.connected", { count: 1 });
  if (media.deafened) return t("common.deafened");
  if (media.speaking && media.mic) return t("status.speaking");
  if (media.screen) return t("status.screenSharing");
  if (media.camera) return t("status.cameraOn");
  if (!media.mic) return t("common.muted");
  return t("room.desktopMic");
}

function voiceStatusItems(media: VoiceMediaState | undefined, t: Translate) {
  if (!media) return [];
  const items: Array<{ label: string; icon: ReactNode; tone: "danger" | "live" | "online" | "warn" }> = [];
  if (media.deafened) {
    items.push({ label: t("common.deafened"), icon: <HeadsetIcon off />, tone: "warn" });
  }
  if (!media.mic || media.deafened) {
    items.push({ label: t("common.muted"), icon: <MicIcon off />, tone: "danger" });
  }
  if (media.screen) {
    items.push({ label: t("status.screenSharing"), icon: <ScreenIcon off={false} />, tone: "live" });
  } else if (media.camera) {
    items.push({ label: t("status.cameraOn"), icon: <CameraIcon off={false} />, tone: "online" });
  }
  if (media.speaking && media.mic && !media.deafened) {
    items.push({ label: t("status.speaking"), icon: <span className="status-dot speaking" />, tone: "live" });
  }
  return items;
}

function voiceMembersForRoom(props: ShellProps, roomId: string) {
  if (props.voiceSnapshots[roomId]) {
    return props.voiceSnapshots[roomId].members;
  }
  if (props.activeVoiceRoomId === roomId) {
    return [{
      user: presenceFromUser(props.user),
      media: {
        mic: props.controls.mic.on,
        camera: props.controls.camera.on,
        screen: props.controls.screenShare.on,
        deafened: props.controls.deafen.on,
        speaking: false
      }
    }];
  }
  return [];
}

function upsertMessage(messages: ChatMessage[], next: ChatMessage) {
  return messages.some((message) => message.id === next.id)
    ? messages.map((message) => (message.id === next.id ? next : message))
    : [...messages, next].slice(-200);
}

function initial(value: string) {
  return value.trim().charAt(0).toUpperCase() || "V";
}

function ArrowIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>; }
function ChatIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14v9H9l-4 4z" /></svg>; }
function MenuIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14" /><path d="M5 12h14" /><path d="M5 17h14" /></svg>; }
function UsersIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 19c0-2.2-1.8-4-4-4s-4 1.8-4 4" /><circle cx="12" cy="9" r="3" /></svg>; }
function ShieldIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 19 7v5c0 4-2.7 6.7-7 8-4.3-1.3-7-4-7-8V7z" /><path d="M9 12h6" /></svg>; }
function PlusIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>; }
function CopyIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h10v10H8z" /><path d="M6 14H5a1 1 0 0 1-1-1V5h8a1 1 0 0 1 1 1v1" /></svg>; }
function TrashIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12" /><path d="M9 7V5h6v2" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M8 7l1 12h6l1-12" /></svg>; }
function LeaveIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8 4 12l4 4" /><path d="M4 12h11" /><path d="M14 5h5v14h-5" /></svg>; }
function MaximizeIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5" /><path d="M16 3h5v5" /><path d="M21 16v5h-5" /><path d="M3 16v5h5" /></svg>; }
function EyeIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 12s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5Z" /><circle cx="12" cy="12" r="2.5" /></svg>; }
function VolumeIcon() { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10h4l5-4v12l-5-4H4z" /><path d="M16 9a4 4 0 0 1 0 6" /><path d="M19 6a8 8 0 0 1 0 12" /></svg>; }
function MicIcon({ off }: { off: boolean }) { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Z" /><path d="M6 11a6 6 0 0 0 12 0" /><path d="M12 17v3" />{off ? <path d="M4 4l16 16" /> : null}</svg>; }
function HeadsetIcon({ off }: { off: boolean }) { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 14v-2a7 7 0 0 1 14 0v2" /><path d="M5 14h3v5H6a1 1 0 0 1-1-1z" /><path d="M16 14h3v4a1 1 0 0 1-1 1h-2z" />{off ? <path d="M4 4l16 16" /> : null}</svg>; }
function CameraIcon({ off }: { off: boolean }) { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h11a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4z" /><path d="m17 11 3-2v6l-3-2z" />{off ? <path d="M4 4l16 16" /> : null}</svg>; }
function ScreenIcon({ off }: { off: boolean }) { return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h8v8H8z" /><path d="M12 4v4" /><path d="m9 6 3-3 3 3" /><path d="M5 12v7h14v-7" />{off ? <path d="M4 4l16 16" /> : null}</svg>; }
