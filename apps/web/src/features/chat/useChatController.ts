import {
  rewriteMentionLabels,
  type ChatMessage,
  type ChatMessageReply,
  type MessageMention,
  type MessageReactionsEvent,
  type PresenceUser,
  type PublicUser,
  type RoomSummary
} from "@voxly/shared";
import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import {
  clearMessageReactions,
  fetchMessageContext,
  setMessagePinned,
  setMessageReaction,
  deleteMessage,
  fetchMessages,
  sendMessage,
  suppressMessageEmbed,
  updateMessage
} from "../../api.js";
import { mergeReactionState } from "../../lib/chatInteractions.js";
import { upsertMessage } from "../../app/presentation.js";
import type { Route } from "../../app/types.js";
import { readRoomHistory, rememberRoom, writeRoomHistory } from "../../lib/channelState.js";
import {
  anonymizeMentions,
  renameMentions,
  anonymizeMessagesForServer,
  renameMessagesForServer
} from "../../lib/memberIdentity.js";
import {
  reconcileMentionContent,
  reconcileMessageIdentity,
  type MemberIdentityChanges
} from "../../lib/memberIdentity.js";
import { canMarkRoomRead } from "../../lib/serverNotifications.js";
import {
  appendOutboxEntry,
  removeOutboxEntry,
  setOutboxEntryStatus,
  type OutboxEntry
} from "../../lib/messageOutbox.js";

export function useChatController({
  user,
  route,
  currentRoom,
  roomServerIds,
  roomHistory,
  setRoomHistory,
  markRead
}: {
  markRead(roomId: string, throughSequence: number): Promise<void>;
  user: PublicUser | null;
  route: Route;
  currentRoom: RoomSummary | undefined;
  roomServerIds: RefObject<Record<string, string>>;
  roomHistory: ReturnType<typeof readRoomHistory>;
  setRoomHistory: Dispatch<SetStateAction<ReturnType<typeof readRoomHistory>>>;
}) {
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, ChatMessage[]>>({});
  const [contextByRoom, setContextByRoom] = useState<Record<string, ChatMessage[]>>({});
  const [historicalRoomId, setHistoricalRoomId] = useState<string | null>(null);
  const historicalRoomRef = useRef<string | null>(null);
  const contextGeneration = useRef(0);
  const reactionSnapshots = useRef<Record<string, MessageReactionsEvent>>({});
  const deletedIds = useRef(new Set<string>());
  const [pinRevisions, setPinRevisions] = useState<Record<string, number>>({});
  const identityChangesRef = useRef<Record<string, MemberIdentityChanges>>({});
  const [identityChangesByServer, setIdentityChangesByServer] = useState<Record<string, MemberIdentityChanges>>({});
  const currentAccountRef = useRef(user?.id);
  currentAccountRef.current = user?.id;
  const [outboxByRoom, setOutboxByRoom] = useState<Record<string, OutboxEntry[]>>({});
  const [loadedWatermarks, setLoadedWatermarks] = useState<Record<string, number>>({});
  const [focusRevision, setFocusRevision] = useState(0);
  const loadedAccountsRef = useRef(new Map<string, string>());
  const latestDeliveredRef = useRef<Record<string, number>>({});
  const readCursorsRef = useRef<Record<string, number>>({});
  const activeTextRoomIdRef = useRef<string | null>(route.name === "text" ? route.roomId : null);
  // One chain per room keeps deliveries serial, so messages land in the order
  // they were composed even though the composer no longer waits for each one.
  const sendChainsRef = useRef<Record<string, Promise<void>>>({});

  useEffect(() => {
    contextGeneration.current++;
    historicalRoomRef.current = null;
    setHistoricalRoomId(null);
    activeTextRoomIdRef.current = route.name === "text" ? route.roomId : null;
    if (route.name !== "text" && route.name !== "voice") return;

    setRoomHistory((current) => {
      const next = rememberRoom(current, route.serverId, route.name, route.roomId);
      writeRoomHistory(window.localStorage, next);
      return next;
    });
  }, [route]);

  useEffect(() => {
    if (!user || route.name !== "text" || currentRoom?.kind !== "text") return;
    let mounted = true;
    loadedAccountsRef.current.delete(route.roomId);
    setLoadedWatermarks((current) => {
      const next = { ...current };
      delete next[route.roomId];
      return next;
    });
    fetchMessages(route.roomId)
      .then((response) => {
        if (mounted) {
          loadedAccountsRef.current.set(route.roomId, user.id);
          setMessagesByRoom((current) => ({
            ...current,
            [route.roomId]: (current[route.roomId] ?? [])
              .filter((message) => message.sequence > response.readThroughSequence)
              .reduce(
                upsertMessage,
                response.messages.filter((message) => !deletedIds.current.has(message.id)).map(withReactions)
              )
          }));
          setLoadedWatermarks((current) => ({
            ...current,
            [route.roomId]: Math.max(response.readThroughSequence, latestDeliveredRef.current[route.roomId] ?? 0)
          }));
        }
      })
      .catch(() => {
        if (mounted) setMessagesByRoom((current) => ({ ...current, [route.roomId]: [] }));
      });
    return () => {
      mounted = false;
    };
  }, [currentRoom, route, user]);

  useEffect(() => {
    setMessagesByRoom({});
    setLoadedWatermarks({});
    readCursorsRef.current = {};
    latestDeliveredRef.current = {};
    loadedAccountsRef.current.clear();
    setContextByRoom({});
    reactionSnapshots.current = {};
    deletedIds.current.clear();
    setPinRevisions({});
    identityChangesRef.current = {};
    setIdentityChangesByServer({});
    setOutboxByRoom({});
    sendChainsRef.current = {};
  }, [user?.id]);
  useEffect(() => {
    const resume = () => setFocusRevision((value) => value + 1);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);
  useEffect(() => {
    if (!user || route.name !== "text" || currentRoom?.id !== route.roomId || historicalRoomId === route.roomId) return;
    const through = loadedWatermarks[route.roomId];
    if (
      !canMarkRoomRead({
        loaded: through !== undefined && loadedAccountsRef.current.get(route.roomId) === user.id,
        visible: document.visibilityState === "visible",
        focused: document.hasFocus()
      }) ||
      through <= (readCursorsRef.current[route.roomId] ?? -1)
    )
      return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void markRead(route.roomId, through)
      .then(() => {
        if (!disposed)
          readCursorsRef.current[route.roomId] = Math.max(readCursorsRef.current[route.roomId] ?? 0, through);
      })
      .catch(() => {
        if (!disposed) retry = setTimeout(() => setFocusRevision((value) => value + 1), 5_000);
      });
    return () => {
      disposed = true;
      clearTimeout(retry);
    };
  }, [user?.id, route, currentRoom?.id, loadedWatermarks, focusRevision, markRead, historicalRoomId]);

  const updateOutbox = (roomId: string, update: (entries: OutboxEntry[]) => OutboxEntry[]) => {
    setOutboxByRoom((current) => ({ ...current, [roomId]: update(current[roomId] ?? []) }));
  };

  function withReactions(message: ChatMessage) {
    message = reconcileMessageIdentity(message, identityChangesRef.current[message.serverId] ?? {});
    const snapshot = reactionSnapshots.current[message.id];
    return snapshot && snapshot.serverId === message.serverId && snapshot.roomId === message.roomId
      ? { ...message, reactionState: mergeReactionState(message.reactionState, snapshot) }
      : message;
  }
  const applyReactions = (event: MessageReactionsEvent) => {
    if (deletedIds.current.has(event.messageId) || roomServerIds.current[event.roomId] !== event.serverId) return;
    const current = reactionSnapshots.current[event.messageId];
    if (current && current.version > event.version) return;
    reactionSnapshots.current[event.messageId] = event;
    const update = (rooms: Record<string, ChatMessage[]>) => ({
      ...rooms,
      [event.roomId]: (rooms[event.roomId] ?? []).map((message) =>
        message.id === event.messageId ? withReactions(message) : message
      )
    });
    setMessagesByRoom(update);
    setContextByRoom(update);
  };
  const applyMessage = (incoming: ChatMessage, unread = false, onlyExisting = false) => {
    if (deletedIds.current.has(incoming.id)) return;
    const message = withReactions(incoming);
    if (message.pinnedAt && !unread)
      setPinRevisions((current) => ({ ...current, [message.roomId]: (current[message.roomId] ?? 0) + 1 }));
    setMessagesByRoom((current) =>
      onlyExisting && !current[message.roomId]?.some((entry) => entry.id === message.id)
        ? current
        : { ...current, [message.roomId]: upsertMessage(current[message.roomId] ?? [], message) }
    );
    setContextByRoom((current) =>
      current[message.roomId]?.some((entry) => entry.id === message.id)
        ? { ...current, [message.roomId]: upsertMessage(current[message.roomId], message) }
        : current
    );
    if (unread)
      latestDeliveredRef.current[message.roomId] = Math.max(
        latestDeliveredRef.current[message.roomId] ?? 0,
        message.sequence
      );
    if (unread && message.roomId === activeTextRoomIdRef.current && historicalRoomRef.current !== message.roomId)
      setLoadedWatermarks((current) =>
        current[message.roomId] === undefined
          ? current
          : { ...current, [message.roomId]: Math.max(current[message.roomId], message.sequence) }
      );
  };
  const applyDeletedMessage = (roomId: string, messageId: string) => {
    deletedIds.current.add(messageId);
    delete reactionSnapshots.current[messageId];
    const remove = (current: Record<string, ChatMessage[]>) => ({
      ...current,
      [roomId]: (current[roomId] ?? [])
        .filter((message) => message.id !== messageId)
        .map((message) => (message.replyToMessageId === messageId ? { ...message, replyTo: null } : message))
    });
    setMessagesByRoom(remove);
    setContextByRoom(remove);
    setPinRevisions((current) => ({ ...current, [roomId]: (current[roomId] ?? 0) + 1 }));
  };

  return {
    messagesByRoom,
    roomHistory,
    activeTextRoomIdRef,
    applyReactions,
    applyPinsChanged: (serverId: string, roomId: string) => {
      if (roomServerIds.current[roomId] === serverId)
        setPinRevisions((current) => ({ ...current, [roomId]: (current[roomId] ?? 0) + 1 }));
    },
    applyNewMessage: (message: ChatMessage) => applyMessage(message, true),
    applyUpdatedMessage: (message: ChatMessage) => applyMessage(message, false, true),
    applyDeletedMessage,
    applyMemberRename: (serverId: string, next: PresenceUser) => {
      const known = identityChangesRef.current[serverId] ?? {};
      if (known[next.userId] === null) return;
      identityChangesRef.current = { ...identityChangesRef.current, [serverId]: { ...known, [next.userId]: next } };
      setIdentityChangesByServer(identityChangesRef.current);
      const rename = (current: Record<string, ChatMessage[]>) =>
        renameMessagesForServer(current, roomServerIds.current, serverId, next);
      setMessagesByRoom(rename);
      setContextByRoom(rename);
      setOutboxByRoom((rooms) =>
        Object.fromEntries(
          Object.entries(rooms).map(([roomId, entries]) => [
            roomId,
            roomServerIds.current[roomId] === serverId
              ? entries.map((entry) => ({
                  ...entry,
                  ...rewriteMentionLabels(entry.body, renameMentions(entry.mentions, next)),
                  replyTo: entry.replyTo
                    ? {
                        ...entry.replyTo,
                        ...rewriteMentionLabels(entry.replyTo.body, renameMentions(entry.replyTo.mentions, next)),
                        ...(entry.replyTo.userId === next.userId && !entry.replyTo.authorDeleted
                          ? { nickname: next.nickname }
                          : {})
                      }
                    : null
                }))
              : entries
          ])
        )
      );
      setPinRevisions((current) =>
        Object.fromEntries(
          Object.entries(current).map(([roomId, revision]) => [
            roomId,
            revision + Number(roomServerIds.current[roomId] === serverId)
          ])
        )
      );
    },
    applyMemberDeletion: (serverId: string, userId: string) => {
      const known = identityChangesRef.current[serverId] ?? {};
      identityChangesRef.current = { ...identityChangesRef.current, [serverId]: { ...known, [userId]: null } };
      setIdentityChangesByServer(identityChangesRef.current);
      const anonymize = (current: Record<string, ChatMessage[]>) =>
        anonymizeMessagesForServer(current, roomServerIds.current, serverId, userId);
      setMessagesByRoom(anonymize);
      setContextByRoom(anonymize);
      setOutboxByRoom((rooms) =>
        Object.fromEntries(
          Object.entries(rooms).map(([roomId, entries]) => [
            roomId,
            roomServerIds.current[roomId] === serverId
              ? entries.map((entry) => ({
                  ...entry,
                  ...rewriteMentionLabels(entry.body, anonymizeMentions(entry.mentions, userId)),
                  replyTo: entry.replyTo
                    ? {
                        ...entry.replyTo,
                        ...rewriteMentionLabels(entry.replyTo.body, anonymizeMentions(entry.replyTo.mentions, userId)),
                        ...(entry.replyTo.userId === userId ? { nickname: "", authorDeleted: true } : {})
                      }
                    : null
                }))
              : entries
          ])
        )
      );
      setPinRevisions((current) =>
        Object.fromEntries(
          Object.entries(current).map(([roomId, revision]) => [
            roomId,
            revision + Number(roomServerIds.current[roomId] === serverId)
          ])
        )
      );
    },
    outboxByRoom,
    actionsForRoom: (roomId: string) => {
      // Never rejects: a failed send is reported on its own outbox row so the
      // composer stays usable and the text is not lost.
      const deliver = async (entry: OutboxEntry) => {
        if (currentAccountRef.current !== user?.id) return;
        try {
          // A serial delivery may wait while an identity is renamed/deleted.
          // Resolve at dispatch time rather than sending the closure's old label.
          const current = reconcileMentionContent(
            entry,
            identityChangesRef.current[roomServerIds.current[roomId]] ?? {}
          );
          const response = await sendMessage(
            roomId,
            current.body,
            current.replyTo?.messageId ?? null,
            current.mentions.filter((mention) => !mention.authorDeleted)
          );
          if (currentAccountRef.current !== user?.id) return;
          updateOutbox(roomId, (entries) => removeOutboxEntry(entries, entry.localId));
          applyMessage(response.message);
        } catch {
          if (currentAccountRef.current !== user?.id) return;
          updateOutbox(roomId, (entries) => setOutboxEntryStatus(entries, entry.localId, "failed"));
        }
      };
      const enqueue = (entry: OutboxEntry) => {
        const chain = (sendChainsRef.current[roomId] ?? Promise.resolve()).then(() => deliver(entry));
        sendChainsRef.current[roomId] = chain;
      };
      return {
        identityChanges: identityChangesByServer[roomServerIds.current[roomId]] ?? {},
        contextMessages: historicalRoomId === roomId ? (contextByRoom[roomId] ?? []) : null,
        pinRevision: pinRevisions[roomId] ?? 0,
        openContext: async (messageId: string) => {
          const generation = ++contextGeneration.current;
          historicalRoomRef.current = roomId;
          setHistoricalRoomId(roomId);
          try {
            const response = await fetchMessageContext(roomId, messageId);
            if (generation !== contextGeneration.current || currentAccountRef.current !== user?.id) return;
            setContextByRoom((current) => ({
              ...current,
              [roomId]: response.messages.filter((message) => !deletedIds.current.has(message.id)).map(withReactions)
            }));
          } catch (error) {
            if (generation === contextGeneration.current) {
              historicalRoomRef.current = null;
              setHistoricalRoomId(null);
            }
            throw error;
          }
        },
        backToLatest: async () => {
          const generation = ++contextGeneration.current;
          const response = await fetchMessages(roomId);
          if (generation !== contextGeneration.current || currentAccountRef.current !== user?.id) return;
          setMessagesByRoom((current) => ({
            ...current,
            [roomId]: (current[roomId] ?? [])
              .filter((message) => message.sequence > response.readThroughSequence)
              .reduce(
                upsertMessage,
                response.messages.filter((message) => !deletedIds.current.has(message.id)).map(withReactions)
              )
          }));
          loadedAccountsRef.current.set(roomId, user!.id);
          setLoadedWatermarks((current) => ({
            ...current,
            [roomId]: Math.max(response.readThroughSequence, latestDeliveredRef.current[roomId] ?? 0)
          }));
          historicalRoomRef.current = null;
          setHistoricalRoomId(null);
        },
        react: async (messageId: string, emoji: string, add: boolean) => {
          const event = await setMessageReaction(roomId, messageId, emoji, add);
          if (currentAccountRef.current === user?.id) applyReactions(event);
        },
        clearReactions: async (messageId: string, emoji?: string) => {
          const event = await clearMessageReactions(roomId, messageId, emoji);
          if (currentAccountRef.current === user?.id) applyReactions(event);
        },
        pin: async (messageId: string, pinned: boolean) => {
          const response = await setMessagePinned(roomId, messageId, pinned);
          if (currentAccountRef.current === user?.id) {
            applyMessage(response.message, false, true);
            setPinRevisions((current) => ({ ...current, [roomId]: (current[roomId] ?? 0) + 1 }));
          }
        },
        send: (body: string, replyTo: ChatMessageReply | null = null, mentions: MessageMention[] = []) => {
          const entry: OutboxEntry = {
            localId: crypto.randomUUID(),
            body,
            createdAt: new Date().toISOString(),
            status: "pending",
            replyTo,
            mentions
          };
          updateOutbox(roomId, (entries) => appendOutboxEntry(entries, entry));
          enqueue(entry);
        },
        retrySend: (localId: string) => {
          const entry = (outboxByRoom[roomId] ?? []).find((candidate) => candidate.localId === localId);
          if (!entry || entry.status !== "failed") return;
          updateOutbox(roomId, (entries) => setOutboxEntryStatus(entries, localId, "pending"));
          enqueue({ ...entry, status: "pending" });
        },
        discardSend: (localId: string) => updateOutbox(roomId, (entries) => removeOutboxEntry(entries, localId)),
        update: async (messageId: string, body: string, mentions: MessageMention[] = []) => {
          const response = await updateMessage(roomId, messageId, body, mentions);
          if (currentAccountRef.current === user?.id) applyMessage(response.message);
        },
        delete: async (messageId: string) => {
          await deleteMessage(roomId, messageId);
          if (currentAccountRef.current === user?.id) applyDeletedMessage(roomId, messageId);
        },
        suppressEmbed: async (messageId: string, embedKey: string) => {
          const response = await suppressMessageEmbed(roomId, messageId, embedKey);
          if (currentAccountRef.current === user?.id) applyMessage(response.message, false, true);
        }
      };
    }
  };
}
