import type { AfkTimeoutMinutes, CategorySummary, MusicCommand,MusicControlAck,MusicQueueState,PresenceUser,PublicUser,RoomSummary,ServerRoomLayout,VisualTarget,VoiceModerationState,VoiceSnapshot } from "@voxly/shared";
import { type AudioLevels } from "../lib/audioLevels.js";
import type { RoomHistory } from "../lib/channelState.js";
import { type LanguageCode,type TranslationKey,type VoiceErrorKey } from "../lib/i18n.js";
import type { UseAudioDevicesResult } from "../lib/useAudioDevices.js";
import type { ConnectionHealth } from "../lib/useConnectionHealth.js";
import type { VoiceQuality } from "../lib/useVoiceQuality.js";
import type { NotificationSoundPreferences } from "../lib/notificationSounds.js";
import type { ExternalPreviewPreferences } from "../lib/externalPreviewPreferences.js";
import type { MessageEmbedProvider } from "../lib/messageEmbeds.js";
import type { TimeFormatPreference } from "../lib/timeFormat.js";
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
  | { name: "link-device" }
  | { name: "recover" }
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
  categories: CategorySummary[];
  uncategorizedPosition: number;
  onlineUsers: PresenceUser[];
  serverMembers: PresenceUser[];
  socketState: "connecting" | "live" | "reconnecting" | "offline";
  connectionHealth: ConnectionHealth;
  voiceQuality: VoiceQuality;
  activeVoiceRoomId: string | null;
  controls: VoiceControls;
  voiceModeration: VoiceModerationState;
  /** The active voice room closes the microphone for everyone in it. */
  micLockedByRoom: boolean;
  appConfig: AppConfigResponse;
  voiceError: VoiceErrorKey | "";
  voiceErrorRevision: number;
  /** Why voice ended when the member did not end it themselves. Not a failure. */
  voiceNotice: TranslationKey | "";
  voiceNoticeRevision: number;
  visualTargets: VisualTarget[];
  voiceSnapshots: Record<string, VoiceSnapshot>;
  /**
   * The Queue each voice room's Music bot last published, keyed by room. The
   * bot is the single source of truth for it; nothing in the browser writes
   * here except the delivery of `music:queue`.
   */
  musicQueues: Record<string, MusicQueueState>;
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
  notificationSounds: NotificationSoundPreferences;
  deletionRequestRevision: number;
  externalPreviews: ExternalPreviewPreferences;
  microphoneTestActive: boolean;
  microphoneTestError: MicrophoneTestError;
  microphoneTestErrorOccurrences: number;
  microphoneTestErrorRevision: number;
  drawer: Drawer;
  theme: ThemeChoice;
  timeFormat: TimeFormatPreference;
  language: LanguageCode;
  t: Translate;
  currentRoom: RoomSummary | undefined;
}

export interface ShellActions {
  onNavigate: (path: string) => void;
  onSelectServer: (serverId: string) => Promise<void>;
  onCreateServer: (name: string) => Promise<void>;
  onUpdateServerName: (name: string) => Promise<ServerSummary>;
  onSetAfkTimeout: (minutes: AfkTimeoutMinutes) => Promise<void>;
  onCreateRoom: (name: string, kind: "text" | "voice", categoryId?: string | null) => Promise<void>;
  onCreateCategory: (name: string) => Promise<void>;
  onRenameCategory: (categoryId: string, name: string) => Promise<void>;
  onDeleteCategory: (categoryId: string) => Promise<void>;
  onSaveRoomLayout: (layout: ServerRoomLayout) => Promise<void>;
  onDeleteRoom: (roomId: string) => Promise<void>;
  onDeleteServer: () => Promise<void>;
  onModerateMember: (userId: string, action: "ban" | "unban" | "kick") => Promise<void>;
  onVoiceModeration: (userId: string, moderation: Partial<VoiceModerationState>) => Promise<{ moderation: VoiceModerationState }>;
  onUpdateMemberNickname: (userId: string, nickname: string) => Promise<PresenceUser>;
  onUpdateMemberPermissions: (userId: string, canInvite: boolean) => Promise<PresenceUser>;
  onDisconnectMember: (roomId: string, userId: string) => Promise<void>;
  onMoveMember: (userId: string, roomId: string) => void;
  onDrawerChange: (drawer: Drawer) => void;
  onThemeChange: (theme: ThemeChoice) => void;
  onTimeFormatChange: (timeFormat: TimeFormatPreference) => void;
  onLanguageChange: (language: LanguageCode) => void;
  onJoinVoice: (roomId: string, options?: VoiceJoinRequest) => Promise<boolean>;
  onWatchLive: (request: LiveWatchRequest) => void;
  onLiveWatchHandled: () => void;
  onRequestVoiceSnapshot: (roomId: string) => void;
  onSetVisualSubscriptions: (targets: VisualTarget[]) => Promise<VisualSubscriptionResult>;
  onMusicControl: (roomId: string, command: MusicCommand) => Promise<MusicControlAck>;
  onMemberVolumeChange: (userId: string, volume: number) => void;
  onScreenVolumeChange: (streamId: string, volume: number) => void;
  onInputVolumeChange: (volume: number) => void;
  onOutputVolumeChange: (volume: number) => void;
  onNoiseSuppressionChange: (enabled: boolean) => void;
  onNotificationSoundsChange: (patch: Partial<NotificationSoundPreferences>) => void;
  onExternalPreviewChange: (provider: MessageEmbedProvider, enabled: boolean) => void;
  onToggleMicrophoneTest: () => Promise<void>;
  onCloseAudioSettings: () => void;
  onToggleControl: (key: keyof VoiceControls) => void;
  onLeaveVoice: () => void;
  onLogout: () => Promise<void>;
}

export interface VoiceChromeModel extends Pick<ShellModel,
  "activeVoiceRoomId" | "controls" | "voiceModeration" | "voiceError" | "voiceErrorRevision" | "voiceNotice" | "voiceNoticeRevision" |
  "visualTargets" | "voiceSnapshots" | "musicQueues" | "remoteStreams" | "peerConnectionStates" |
  "localPreviews" | "memberVolumes" | "screenVolumes" | "pendingLiveWatch" |
  "audioDevices" | "audioLevels" | "microphoneTestActive" | "microphoneTestError" |
  "microphoneTestErrorOccurrences" | "microphoneTestErrorRevision"
> {}
