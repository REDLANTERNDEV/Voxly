import { Ear, describeHearing, soundedLikeMusic } from "./ear.js";
import { VoiceMesh } from "./mesh.js";
import { joinAsParticipant, meshFor, readEnvironment } from "./participant.js";

/**
 * A headless Listener, for checking the bot without a browser or a person.
 *
 * It decodes what arrives and reports the level, so "negotiated fine, delivered
 * silence" cannot pass for success.
 */

const environment = readEnvironment({ nickname: "Spike listener" });
const seconds = Number(process.env.VOXLY_LISTEN_SECONDS ?? "12");

const participant = await joinAsParticipant({ ...environment, log });
const ear = new Ear();

const mesh = new VoiceMesh({
  ...meshFor(participant),
  relayOnly: environment.relayOnly,
  onRemoteTrack: (userId, track) => ear.listenTo(userId, track),
  onPeerRemoved: (userId) => ear.forget(userId),
  log
});
mesh.start();
log(`listening for ${seconds}s`);

await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));

const report = ear.report();
for (const hearing of report) log(describeHearing(hearing));
ear.close();
await mesh.stop();
await participant.leave();

const heardSomething = report.some(soundedLikeMusic);
log(heardSomething ? "HEARD IT" : "HEARD NOTHING");
process.exit(heardSomething ? 0 : 1);

function log(message: string) {
  console.log(`[listener] ${message}`);
}
