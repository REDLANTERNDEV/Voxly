/**
 * The Queue, as the browser receives it.
 *
 * Nothing here decides anything. The Music bot owns the Queue and publishes the
 * whole of it on every change (ADR-0005); this holds the last thing it said,
 * per room, so the panel can render it. There is no optimistic update and no
 * merging of deltas, because a room where two members disagree about what is
 * coming next is exactly what the design is preventing.
 *
 * Keyed by room because a member can be looking at one voice channel while
 * connected to another, and the panel must never show one room's Queue under
 * another room's name.
 */

import { useEffect, useState } from "react";
import type { MusicQueueState } from "@voxly/shared";
import type { VoxlySocket } from "../socket.js";

export function useMusicQueue(socket: VoxlySocket | null): Record<string, MusicQueueState> {
  const [queues, setQueues] = useState<Record<string, MusicQueueState>>({});

  useEffect(() => {
    // A new socket is a new session's worth of state. What the previous one was
    // told is not evidence about a room this one has not heard from yet, and
    // the bot republishes when the roster changes — which a reconnecting member
    // rejoining the channel is.
    setQueues({});
    if (!socket) return;
    const onQueue = ({ roomId, state }: { roomId: string; state: MusicQueueState }) => {
      setQueues((current) => ({ ...current, [roomId]: state }));
    };
    socket.on("music:queue", onQueue);
    // Braced: `off` hands the socket back, and an effect whose cleanup returns
    // something is not a cleanup as far as React is concerned.
    return () => { socket.off("music:queue", onQueue); };
  }, [socket]);

  return queues;
}
