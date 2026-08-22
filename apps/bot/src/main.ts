import { readFileSync } from "node:fs";
import { bundledTrackPath, readOggOpus } from "./audio.js";
import { resolveBotEnvironment } from "./config.js";
import { createSessionHolder } from "./credentials.js";
import { createMusicResponder } from "./music.js";
import { createMusicBotPresence } from "./presence.js";
import { setSocketFor } from "./socket.js";
import { fetchIceServers } from "./voxly.js";

/**
 * A configuration mistake is worth exiting for — there is nothing to serve
 * without it, and a process that stays up hides the message. Everything after
 * that is a running service and follows the server's posture: log and keep
 * going rather than take the music down over one fault.
 */
let environment;
try {
  environment = resolveBotEnvironment(process.env);
} catch (cause) {
  console.error((cause as Error).message);
  process.exit(1);
}

/**
 * Read and packetised once for the whole process, not once per server or once
 * per Set. It is the same bytes every Listener everywhere receives.
 */
const track = readOggOpus(readFileSync(bundledTrackPath));

process.on("uncaughtException", (error) => {
  console.error("uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection", reason);
});

const presence = createMusicBotPresence({
  environment,
  attach: ({ socket, session, cookieName }) => {
    const credentials = createSessionHolder(environment, session);
    const responder = createMusicResponder({
      socket: setSocketFor(socket),
      selfUserId: session.userId,
      packets: track.packets,
      loadIceServers: () => fetchIceServers({
        serverUrl: environment.serverUrl,
        cookieName,
        sessionToken: credentials.token,
        refreshSession: () => credentials.refresh()
      }),
      log: (message) => console.log(`[${session.serverId}] ${message}`)
    });
    socket.on("music:command", (payload) => {
      void responder.handle(payload.command, payload.roomId);
    });
    return () => responder.close();
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Awaited rather than fired: leaving a room takes a round trip, and a bot
    // that exits before it lands leaves the room showing it as still playing
    // until the server notices the socket has gone.
    void presence.stop().finally(() => process.exit(0));
  });
}

await presence.start();
