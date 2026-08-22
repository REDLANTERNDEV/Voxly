/**
 * Keeping the Music bot online.
 *
 * One connection per bot account, because each server has its own account and a
 * socket carries exactly one identity. Reconnection is owned here rather than
 * left to Socket.IO: the handshake carries a session that expires, so a retry
 * has to re-run the credential exchange first. Socket.IO's own reconnect would
 * replay a stale cookie forever.
 */

import { io as createClient } from "socket.io-client";
import type { BotEnvironment } from "./config.js";
import type { BotCredentials, BotSession } from "./credentials.js";
import { requestBotCredentials } from "./credentials.js";
import { setSocketFor, type BotSocket } from "./socket.js";

export type { BotSocket };

/** Backs off to a minute, which is the right pace for a server that is down. */
export function retryDelayMs(attempt: number) {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 60_000);
}

export function connectBotSession(serverUrl: string, cookieName: string, session: BotSession): BotSocket {
  return createClient(serverUrl, {
    transports: ["websocket"],
    extraHeaders: { cookie: `${cookieName}=${session.token}` },
    // See the module comment: a reconnect needs a fresh session, not this one.
    reconnection: false
  });
}

/**
 * What a connected server's socket is handed to, so playback can be wired to it.
 * Returns the teardown for whatever it attached; presence calls it when the
 * connection goes away, which is what stops a Set outliving its transport.
 */
export type AttachToServer = (context: {
  socket: BotSocket;
  session: BotSession;
  cookieName: string;
}) => () => void | Promise<void>;

export interface MusicBotPresenceOptions {
  environment: BotEnvironment;
  /** Optional so presence can be tested, and started, without any audio. */
  attach?: AttachToServer;
  requestCredentials?: (environment: BotEnvironment) => Promise<BotCredentials>;
  connect?: (serverUrl: string, cookieName: string, session: BotSession) => BotSocket;
  /** Injected so tests do not wait out a real backoff. */
  wait?: (milliseconds: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface MusicBotPresence {
  /**
   * Resolves once every account is connected. It keeps retrying rather than
   * rejecting, so a bot started before the server is ready simply waits.
   */
  start: () => Promise<void>;
  /**
   * Resolves once every connection has been closed and whatever was attached to
   * it has finished. Await it before exiting: a Set that has not said it is
   * leaving is a bot the room still believes is playing.
   */
  stop: () => Promise<void>;
  connectedServerIds: () => string[];
}

export function createMusicBotPresence(options: MusicBotPresenceOptions): MusicBotPresence {
  const requestCredentials = options.requestCredentials ?? requestBotCredentials;
  const connect = options.connect ?? connectBotSession;
  // Deliberately not `unref`ed. Between losing the last socket and opening the
  // next one, this timer is the only thing referencing the event loop — an
  // unreferenced one lets Node decide the process has nothing left to do and
  // exit silently, mid-backoff, exactly when the server is down. Tests inject
  // their own `wait` and never reach this.
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const log = options.log ?? ((message: string) => console.log(message));

  const sockets = new Map<string, BotSocket>();
  const detachers = new Map<string, () => void | Promise<void>>();
  let running = false;
  let cycle: Promise<void> | null = null;

  /**
   * Awaited, not fired and forgotten. A Set says it is leaving — `speaking:
   * false`, then `voice:leave` — over the socket it is leaving on, so the
   * detacher has to finish before that socket goes. Disconnecting first would
   * leave the room's last word on the bot being that it was playing, until the
   * server noticed the socket had gone.
   *
   * The maps are emptied up front, before the first await, so a second
   * disconnect arriving mid-teardown finds nothing to tear down again.
   */
  async function dropSockets() {
    const closing = [...sockets.entries()];
    const detaching = new Map(detachers);
    sockets.clear();
    detachers.clear();
    for (const [serverId, socket] of closing) {
      try {
        // `try` rather than `.catch`, because a detacher that throws
        // synchronously never produces a promise to catch on — and a failure
        // here must still leave the socket closed.
        await detaching.get(serverId)?.();
      } catch (cause) {
        log(`Music bot could not close its work for server ${serverId} cleanly: ${String(cause)}`);
      }
      socket.removeAllListeners();
      socket.disconnect();
    }
  }

  /**
   * A dropped connection retires the whole set rather than reconnecting the one
   * that fell over. The sessions were minted together and the exchange retires
   * the previous ones, so refreshing a single account would invalidate the
   * credentials the others are still holding.
   *
   * The wait before re-authenticating is what keeps a server that accepts a
   * handshake and immediately drops it from becoming a hot loop against the
   * exchange endpoint.
   */
  function onConnectionLost(serverId: string, cause: string) {
    if (!running || !sockets.has(serverId)) return;
    log(`Music bot lost its connection for server ${serverId} (${cause}); re-authenticating.`);
    cycle = reconnect();
    void cycle.catch(() => {});
  }

  async function reconnect() {
    await dropSockets();
    await wait(retryDelayMs(1));
    if (!running) return;
    await connectAll();
  }

  /**
   * Resolves once the socket has actually completed its handshake, so a server
   * that answers the credential exchange but refuses the upgrade is a failure
   * the retry loop can see. Wiring the loss handlers here instead would report
   * that failure after `connectOnce` had already claimed success, and the
   * backoff would never run.
   */
  function openSession(cookieName: string, session: BotSession) {
    return new Promise<BotSocket>((resolve, reject) => {
      const socket = connect(options.environment.serverUrl, cookieName, session);
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", (cause: Error) => {
        socket.removeAllListeners();
        socket.disconnect();
        reject(new Error(`server ${session.serverId} refused the connection: ${cause.message}`));
      });
    });
  }

  async function connectOnce() {
    const credentials = await requestCredentials(options.environment);
    for (const session of credentials.sessions) {
      if (!running) return;
      sockets.set(session.serverId, await openSession(credentials.cookieName, session));
    }
    // Only once every account is up, so a failure part-way through is reported
    // to the retry loop rather than mistaken for a connection that dropped.
    for (const session of credentials.sessions) {
      const socket = sockets.get(session.serverId);
      if (!socket) continue;
      // The reason is the whole diagnosis when a bot starts reconnecting in a
      // loop: a transport close and a server-side disconnect need different
      // answers from whoever is reading the log.
      socket.on("disconnect", (reason: string) => onConnectionLost(session.serverId, reason));
      socket.on("connect_error", (cause: Error) => onConnectionLost(session.serverId, cause.message));
      const detach = options.attach?.({ socket, session, cookieName: credentials.cookieName });
      if (detach) detachers.set(session.serverId, detach);
    }
    log(`Music bot online in ${credentials.sessions.length} server(s).`);
  }

  async function connectAll() {
    for (let attempt = 1; running; attempt += 1) {
      try {
        await connectOnce();
        return;
      } catch (cause) {
        await dropSockets();
        if (!running) return;
        const delay = retryDelayMs(attempt);
        log(`Music bot could not connect (${(cause as Error).message}); retrying in ${delay}ms.`);
        await wait(delay);
      }
    }
  }

  return {
    async start() {
      if (running) return cycle ?? Promise.resolve();
      running = true;
      cycle = connectAll();
      await cycle;
    },
    stop() {
      running = false;
      return dropSockets();
    },
    connectedServerIds: () => [...sockets.keys()]
  };
}
