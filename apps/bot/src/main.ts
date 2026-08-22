import { resolveBotEnvironment } from "./config.js";
import { createMusicBotPresence } from "./presence.js";

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

const presence = createMusicBotPresence({ environment });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    presence.stop();
    process.exit(0);
  });
}

await presence.start();
