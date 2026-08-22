/**
 * Keeping the Music bot online.
 *
 * One connection per bot account, because each server has its own account and a
 * socket carries exactly one identity. Reconnection is owned here rather than
 * left to Socket.IO: the handshake carries a session that expires, so a retry
 * has to re-run the credential exchange first. Socket.IO's own reconnect would
 * replay a stale cookie forever.
 */

import { io as createClient, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@voxly/shared";
import type { BotEnvironment } from "./config.js";
import type { BotCredentials, BotSession } from "./credentials.js";
import { requestBotCredentials } from "./credentials.js";

export type BotSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

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

export interface MusicBotPresenceOptions {
  environment: BotEnvironment;
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
  stop: () => void;
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
  let running = false;
  let cycle: Promise<void> | null = null;

  function dropSockets() {
    for (const socket of sockets.values()) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    sockets.clear();
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
  function onConnectionLost(serverId: string) {
    if (!running || !sockets.has(serverId)) return;
    log(`Music bot lost its connection for server ${serverId}; re-authenticating.`);
    dropSockets();
    cycle = reconnect();
    void cycle.catch(() => {});
  }

  async function reconnect() {
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
    for (const [serverId, socket] of sockets) {
      socket.on("disconnect", () => onConnectionLost(serverId));
      socket.on("connect_error", () => onConnectionLost(serverId));
    }
    log(`Music bot online in ${credentials.sessions.length} server(s).`);
  }

  async function connectAll() {
    for (let attempt = 1; running; attempt += 1) {
      try {
        await connectOnce();
        return;
      } catch (cause) {
        dropSockets();
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
      dropSockets();
    },
    connectedServerIds: () => [...sockets.keys()]
  };
}
