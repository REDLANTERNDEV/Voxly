import { readFileSync } from "node:fs";
import { bundledTrackPath, readOggOpus } from "./audio.js";
import { VoiceMesh } from "./mesh.js";
import { joinAsParticipant, meshFor, readEnvironment } from "./participant.js";
import { TrackPlayer } from "./player.js";

/**
 * The spike itself: authenticate as an ordinary member, join a voice room, and
 * play the bundled Track to everyone in it, forever, until interrupted.
 *
 * Run this, then join the same room in a browser with headphones on.
 */

const environment = readEnvironment({ nickname: "Music bot (spike)" });
const track = readOggOpus(readFileSync(bundledTrackPath));
log(`Track: ${track.packets.length} Opus packets, ${track.channels} channel, pre-skip ${track.preSkip}`);
if (environment.relayOnly) log("relay only: refusing host and reflexive candidates, every packet must go via TURN");

const participant = await joinAsParticipant({ ...environment, media: { mic: true }, log });
const player = new TrackPlayer(track.packets);

const mesh = new VoiceMesh({
  ...meshFor(participant),
  relayOnly: environment.relayOnly,
  createOutput: (peerUserId) => player.outputFor(peerUserId),
  onPeerRemoved: (peerUserId) => player.release(peerUserId),
  log
});
mesh.start();
player.start();
log("playing — join this room in a browser to hear it");

const ticker = setInterval(() => {
  const { seconds, listeners, loops } = player.progress;
  log(`${seconds.toFixed(0)}s played to ${listeners} listener(s), ${loops} loop(s)`);
}, 5_000);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(ticker);
    player.stop();
    void mesh.stop().then(() => participant.leave()).finally(() => process.exit(0));
  });
}

function log(message: string) {
  console.log(`[bot] ${message}`);
}
