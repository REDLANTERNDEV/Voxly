import { resolveBotEnvironment } from "./config.js";
import { createSessionHolder } from "./credentials.js";
import { createMusicResponder } from "./music.js";
import { createMusicBotPresence } from "./presence.js";
import { publishQueueVia, setSocketFor } from "./socket.js";
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
    const log = (message: string) => console.log(`[${session.serverId}] ${message}`);
    const responder = createMusicResponder({
      socket: setSocketFor(socket),
      selfUserId: session.userId,
      environment,
      publish: publishQueueVia(socket, log),
      loadIceServers: () => fetchIceServers({
        serverUrl: environment.serverUrl,
        cookieName,
        sessionToken: credentials.token,
        refreshSession: () => credentials.refresh()
      }),
      log
    });
    socket.on("music:command", (payload, ack) => {
      // Answered rather than fired: the member who asked is waiting on this,
      // and it is the only route by which "that link will not play" reaches
      // them. `handle` resolves to an answer for every outcome, including the
      // ones it had to log.
      void responder.handle(payload.command, payload.roomId, payload.requestedByUserId).then(ack);
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
