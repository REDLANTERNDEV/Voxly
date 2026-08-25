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
  /**
   * Who is in the voice room changed — somebody arrived or left. Media changes
   * are deliberately not this: a snapshot lands every time anyone starts or
   * stops talking, and this is about the roster.
   *
   * **The bot is not in the list.** It is an ordinary member of the voice room
   * and therefore in its own roster, so handing the roster through unchanged
   * would report a Listener for a room that everybody has left — and the Grace
   * period, which is the one thing that needs this, is about exactly that room.
   * Taking itself out is the Set's job because the Set is the only thing here
   * that knows which member it is.
   *
   * It used to carry nothing, on the grounds that the roster was already in the
   * snapshots its listener receives and a copy would be a shape nobody had a
   * reason to get right. The Grace period is that reason.
   */
  onListenersChanged?: (listenerUserIds: string[]) => void;
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
  /**
   * What the Queue asked for, which is not the same as what the player is
   * doing. An owner's mute stops the sound without the Queue being told, so the
   * two have to be held apart: this is what the microphone coming back resumes,
   * and it is what a mute must not quietly turn off.
   */
  let playbackRequested = false;
  /**
   * Whether the server has taken the bot's microphone away.
   *
   * Media in Voxly is peer-to-peer, so the server cannot stop packets it never
   * sees: its moderation state is *advisory* for audio and the bot has to
   * enforce it on itself. Without this the bot goes on playing into every
   * browser in the room while its own row shows the red locked mute — which is
   * what the ticket 03 spike watched happen.
   */
  let silenced = false;

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

  /**
   * The room's roster as of the last snapshot, so a snapshot that only says
   * somebody started talking is not reported as somebody arriving. Sorted and
   * joined rather than compared as a set, because the comparison happens on
   * every snapshot and the rooms are small.
   */
  let roster = "";

  const onSnapshot = (snapshot: VoiceSnapshot) => {
    if (ended) return;
    mesh.applySnapshot(snapshot);
    if (snapshot.roomId !== roomId) return;
    // A member the room does not list has no microphone here to read. That is
    // an ordinary snapshot for a room the bot has not joined yet, and reading
    // an absent member as a silenced one would stop a Set nobody moderated.
    const self = snapshot.members.find((member) => member.user.userId === options.selfUserId);
    if (self) applyModeration(self.media.mic === false);
    const next = snapshot.members.map((member) => member.user.userId).sort().join(",");
    if (next === roster) return;
    roster = next;
    // Read off the snapshot rather than from `mesh.listenerUserIds`, which
    // looks like the same list and is not. That one is who the bot holds a peer
    // for — a media fact — and `removePeer` is asynchronous, so the Listener
    // who has just left is still in it here. Starting a Grace period from it
    // would mean the last one out never starts one at all, because no further
    // snapshot is coming.
    options.onListenersChanged?.(
      snapshot.members
        .map((member) => member.user.userId)
        .filter((userId) => userId !== options.selfUserId)
    );
  };

  /**
   * The server's word on whether this bot may be heard, applied to the thing
   * that is actually making the sound.
   *
   * What is read is the server's **conclusion**, not its reasons. `mic` is
   * where `normalizeVoiceMedia` puts an owner's mute *and* the AFK room's
   * forced mute, and the AFK room is not on the snapshot at all — so the
   * microphone is the only fact here that says both, and re-deriving the rules
   * from `moderation` would be a second opinion that could disagree with the
   * server's.
   *
   * Silencing is not pausing. The Queue is not told, goes on advancing, and
   * still says it is playing — which is honest, because it is: the room's panel
   * reads the Queue and the bot's own row carries the mute the server enforced,
   * exactly as it would for a person cut off mid-sentence.
   */
  function applyModeration(nowSilenced: boolean) {
    if (nowSilenced === silenced) return;
    silenced = nowSilenced;
    log(silenced
      ? "the server says the bot's microphone is off; stopping until it is back"
      : `the bot's microphone is back${playbackRequested ? "; carrying on" : ""}`);
    syncPlayer();
  }

  /**
   * The one place the two facts are put together: the player sounds when the
   * Queue asked for it **and** the server has left the bot a microphone.
   *
   * Written once rather than at each of the three places that change one of the
   * two, so there is no direction of travel in which the rule can be half
   * applied. Resuming is deliberately not a restart — `TrackPlayer.start()`
   * carries on from where its clock stopped — and an owner lifting a mute is
   * not a member pressing Play, so a Queue somebody paused stays paused.
   */
  function syncPlayer() {
    if (playbackRequested && !silenced) {
      player.start();
      return;
    }
    player.stop();
  }

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
      // The Queue does not know about the mute and will go on advancing through
      // Tracks while one is in force, so `syncPlayer` is not only about the
      // Track that was playing when the mute landed.
      playbackRequested = true;
      syncPlayer();
    },
    stop() {
      playbackRequested = false;
      syncPlayer();
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
