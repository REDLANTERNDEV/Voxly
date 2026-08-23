/**
 * One Set: the stretch from a Summon until the Music bot leaves the voice room.
 *
 * A Set owns the three things that have to start and stop together — the voice
 * membership, the mesh of Listener connections, and the player writing frames
 * into them — so ending it cannot leave one of them behind. Everything it does
 * goes through the same events a browser uses.
 *
 * The speaking indicator is published from here for a reason worth stating.
 * Nothing in Voxly measures received audio: a client measures its own
 * microphone and publishes `voice:setMediaState({ speaking })`, and everyone
 * else renders what the sender claimed. So a bot that never reported would play
 * into a room where its own row stayed dark, and no amount of UI work would
 * light it. Playing is the bot's equivalent of talking, so playback state is
 * what it reports.
 */

import type {
  VoiceForceLeaveReason,
  VoiceJoinAck,
  VoiceMediaState,
  VoiceSetMediaAck,
  VoiceSnapshot
} from "@voxly/shared";
import { VoiceMesh, type MeshSignalling } from "./mesh.js";
import type { TrackBuffer } from "./audio.js";
import { TrackPlayer } from "./player.js";
import type { IceServer } from "./voxly.js";

/**
 * The bot arrives with the microphone on and hears nobody. `mic` is not
 * cosmetic: the server clamps `speaking` to false for a member whose microphone
 * is off, so a bot that joined muted could never light its own indicator.
 * `deafened` would clamp the microphone the same way, which is why a peer that
 * listens to nothing still does not claim to be deafened.
 */
export const musicBotMedia: VoiceMediaState = {
  mic: true,
  camera: false,
  screen: false,
  deafened: false,
  speaking: false
};

/** How long to wait for the server to acknowledge a join before giving up. */
export const joinTimeoutMs = 5_000;

/** The socket surface a Set uses, narrowed so a test can stand in for one. */
export interface SetSocket extends MeshSignalling {
  join: (payload: { roomId: string; media: VoiceMediaState }, ack: (response: VoiceJoinAck) => void) => void;
  leave: (roomId: string) => void;
  setMediaState: (
    payload: { roomId: string; media: Partial<VoiceMediaState> },
    ack: (response: VoiceSetMediaAck) => void
  ) => void;
  onSnapshot: (handler: (snapshot: VoiceSnapshot) => void) => void;
  offSnapshot: (handler: (snapshot: VoiceSnapshot) => void) => void;
  /**
   * The server took the bot out of a room — an owner disconnected it, or the
   * room is gone. Voice moderation applies to the bot exactly as it does to a
   * person, so this is an eviction to obey, not a condition to recover from.
   */
  onForceLeave: (handler: (payload: { roomId: string; reason: VoiceForceLeaveReason }) => void) => void;
  offForceLeave: (handler: (payload: { roomId: string; reason: VoiceForceLeaveReason }) => void) => void;
}

export interface MusicSetOptions {
  socket: SetSocket;
  roomId: string;
  selfUserId: string;
  iceServers: IceServer[];
  /** The Track that was playing ended of its own accord. */
  onTrackEnded?: () => void;
  log?: (message: string) => void;
}

export interface MusicSet {
  readonly roomId: string;
  readonly playing: boolean;
  readonly listenerUserIds: string[];
  /** Joins the room. Rejects if the server refuses, so the Summon can report it. */
  begin: () => Promise<void>;
  /**
   * Play this Track from its beginning. The buffer may still be filling; the
   * player waits for it rather than the Set waiting to be handed a whole Track.
   */
  loadTrack: (audio: TrackBuffer) => void;
  play: () => void;
  stop: () => void;
  /** Ends the Set. Safe to call twice; the second call does nothing. */
  end: () => Promise<void>;
}

export function createMusicSet(options: MusicSetOptions): MusicSet {
  const log = options.log ?? (() => undefined);
  const { socket, roomId } = options;
  let joined = false;
  let ended = false;

  const player = new TrackPlayer({
    onPlayingChange: (playing) => publishSpeaking(playing),
    onEnded: () => {
      log("the Track ended");
      options.onTrackEnded?.();
    }
  });

  const mesh = new VoiceMesh({
    signalling: socket,
    roomId,
    selfUserId: options.selfUserId,
    iceServers: options.iceServers,
    // Every Listener gets a track of its own, fed from the shared packets. The
    // track is attached when the connection is built rather than when playback
    // starts, so starting the music needs no renegotiation.
    createOutput: (peerUserId) => player.outputFor(peerUserId),
    onListenerConnected: (peerUserId) => player.startTalkspurt(peerUserId),
    onPeerRemoved: (peerUserId) => player.release(peerUserId),
    log
  });

  const onSnapshot = (snapshot: VoiceSnapshot) => {
    if (ended) return;
    mesh.applySnapshot(snapshot);
  };

  /**
   * Only once the join is acknowledged. A media update for a room the bot is
   * not in is refused, and reporting that refusal as a fault would turn every
   * failed Summon into a misleading log line.
   */
  function publishSpeaking(speaking: boolean) {
    if (!joined) return;
    socket.setMediaState({ roomId, media: { speaking } }, (response) => {
      if (!response.ok) log(`the server refused a speaking update: ${response.error}`);
    });
  }

  return {
    roomId,
    get playing() {
      return player.playing;
    },
    get listenerUserIds() {
      return mesh.listenerUserIds;
    },
    async begin() {
      // Subscribed before the join so the snapshot the server publishes as part
      // of it is not missed; that snapshot is how the bot learns who is already
      // in the room and waiting to hear something.
      socket.onSnapshot(onSnapshot);
      mesh.start();
      const ack = await new Promise<VoiceJoinAck>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("voice:join was never acknowledged")), joinTimeoutMs);
        socket.join({ roomId, media: musicBotMedia }, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
      });
      if (!ack.ok) {
        await this.end();
        throw new Error(`voice:join refused: ${ack.error}`);
      }
      joined = true;
      log(`joined voice room ${roomId}`);
    },
    loadTrack(audio) {
      if (ended) return;
      player.load(audio);
    },
    play() {
      if (ended) return;
      player.start();
    },
    stop() {
      player.stop();
    },
    async end() {
      if (ended) return;
      ended = true;
      // Order matters: stop producing first, so the `speaking: false` that
      // playback's own stop publishes still goes out over a live membership.
      // Tearing the transport down first would leave the last `speaking: true`
      // as the room's final word on the bot.
      player.close();
      socket.offSnapshot(onSnapshot);
      await mesh.stop();
      if (joined) {
        socket.leave(roomId);
        joined = false;
        log(`left voice room ${roomId}`);
      }
    }
  };
}
