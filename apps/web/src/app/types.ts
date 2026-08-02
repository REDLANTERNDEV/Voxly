import type { PresenceUser,PublicUser,RoomSummary,VisualTarget,VoiceModerationState,VoiceSnapshot } from "@voxly/shared";
import { type AudioLevels } from "../lib/audioLevels.js";
import type { RoomHistory } from "../lib/channelState.js";
import { type LanguageCode,type TranslationKey } from "../lib/i18n.js";
import type { UseAudioDevicesResult } from "../lib/useAudioDevices.js";
import type { ConnectionHealth } from "../lib/useConnectionHealth.js";
import type { MicrophoneTestError } from "../lib/useMicrophoneTest.js";
import { type VoiceControls } from "../lib/voiceControls.js";
import { type PeerConnectionState } from "../lib/voiceNegotiation.js";
import type { VisualSubscriptionResult } from "../lib/voiceRecovery.js";
import { type RemoteStreamState } from "../lib/voiceStreams.js";
import type { AppConfigResponse,ServerSummary } from "../types.js";

export type Route =
  | { name: "landing" }
  | { name: "invite"; token: string }
  | { name: "owner-claim"; token: string }
  | { name: "access-claim"; token: string }
  | { name: "text"; serverId: string; roomId: string }
  | { name: "voice"; serverId: string; roomId: string }
  | { name: "owner"; serverId: string };
export type LoadState = "loading" | "ready" | "error";
export type ThemeChoice = "auto" | "light" | "dark";
export type Drawer = "channels" | "members" | null;
export type MemberAction = "disconnect" | "ban" | "kick";
export type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;
export type LiveWatchRequest = { serverId: string; roomId: string; publisherUserId: string; nickname: string };
export type VoiceJoinRequest = { microphoneEnabled?: boolean; visualTargets?: VisualTarget[] };

export interface ShellModel {
  user: PublicUser;
  currentNickname: string;
  route: Route;
  servers: ServerSummary[];
  activeServerId: string;
  rooms: { text: RoomSummary[]; voice: RoomSummary[] };
  onlineUsers: PresenceUser[];
  serverMembers: PresenceUser[];
  socketState: "connecting" | "live" | "reconnecting" | "offline";
  connectionHealth: ConnectionHealth;
  activeVoiceRoomId: string | null;
  controls: VoiceControls;
  voiceModeration: VoiceModerationState;
  appConfig: AppConfigResponse;
  voiceError: string;
  visualTargets: VisualTarget[];
  voiceSnapshots: Record<string, VoiceSnapshot>;
  remoteStreams: RemoteStreamState[];
  peerConnectionStates: Record<string, PeerConnectionState>;
  localPreviews: Array<{ kind: "camera" | "screen"; stream: MediaStream }>;
  memberVolumes: Record<string, number>;
  screenVolumes: Record<string, number>;
  unreadByRoom: Record<string, number>;
  roomHistory: RoomHistory;
  pendingLiveWatch: LiveWatchRequest | null;
  audioDevices: UseAudioDevicesResult;
  audioLevels: AudioLevels;
  noiseSuppression: boolean;
  noiseSuppressionSupported: boolean;
  microphoneTestActive: boolean;
  microphoneTestError: MicrophoneTestError;
  drawer: Drawer;
  theme: ThemeChoice;
  language: LanguageCode;
  t: Translate;
  currentRoom: RoomSummary | undefined;
}

export interface ShellActions {
  onNavigate: (path: string) => void;
  onSelectServer: (serverId: string) => Promise<void>;
  onCreateServer: (name: string) => Promise<void>;
  onUpdateServerName: (name: string) => Promise<ServerSummary>;
  onCreateRoom: (name: string, kind: "text" | "voice") => Promise<void>;
  onDeleteRoom: (roomId: string) => Promise<void>;
  onDeleteServer: () => Promise<void>;
  onModerateMember: (userId: string, action: "ban" | "unban" | "kick") => Promise<void>;
  onVoiceModeration: (userId: string, moderation: Partial<VoiceModerationState>) => Promise<{ moderation: VoiceModerationState }>;
  onUpdateMemberNickname: (userId: string, nickname: string) => Promise<PresenceUser>;
  onUpdateMemberPermissions: (userId: string, canInvite: boolean) => Promise<PresenceUser>;
  onDisconnectMember: (roomId: string, userId: string) => Promise<void>;
  onDrawerChange: (drawer: Drawer) => void;
  onThemeChange: (theme: ThemeChoice) => void;
  onLanguageChange: (language: LanguageCode) => void;
  onJoinVoice: (roomId: string, options?: VoiceJoinRequest) => Promise<boolean>;
  onWatchLive: (request: LiveWatchRequest) => void;
  onLiveWatchHandled: () => void;
  onRequestVoiceSnapshot: (roomId: string) => void;
  onSetVisualSubscriptions: (targets: VisualTarget[]) => Promise<VisualSubscriptionResult>;
  onMemberVolumeChange: (userId: string, volume: number) => void;
  onScreenVolumeChange: (streamId: string, volume: number) => void;
  onInputVolumeChange: (volume: number) => void;
  onOutputVolumeChange: (volume: number) => void;
  onNoiseSuppressionChange: (enabled: boolean) => void;
  onToggleMicrophoneTest: () => Promise<void>;
  onCloseAudioSettings: () => void;
  onToggleControl: (key: keyof VoiceControls) => void;
  onLeaveVoice: () => void;
  onLogout: () => Promise<void>;
}

export interface VoiceChromeModel extends Pick<ShellModel,
  "activeVoiceRoomId" | "controls" | "voiceModeration" | "voiceError" |
  "visualTargets" | "voiceSnapshots" | "remoteStreams" | "peerConnectionStates" |
  "localPreviews" | "memberVolumes" | "screenVolumes" | "pendingLiveWatch" |
  "audioDevices" | "audioLevels" | "microphoneTestActive" | "microphoneTestError"
> {}
