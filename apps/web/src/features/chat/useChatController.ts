import type { ChatMessage,ChatMessageReply,PresenceUser,PublicUser,RoomSummary } from "@voxly/shared";
import { useEffect,useRef,useState,type Dispatch,type RefObject,type SetStateAction } from "react";
import { deleteMessage,fetchMessages,sendMessage,suppressMessageEmbed,updateMessage } from "../../api.js";
import { upsertMessage } from "../../app/presentation.js";
import type { Route } from "../../app/types.js";
import { readRoomHistory,rememberRoom,writeRoomHistory } from "../../lib/channelState.js";
import { anonymizeMessagesForServer,renameMessagesForServer } from "../../lib/memberIdentity.js";
import { canMarkRoomRead } from "../../lib/serverNotifications.js";
import { appendOutboxEntry,removeOutboxEntry,setOutboxEntryStatus,type OutboxEntry } from "../../lib/messageOutbox.js";

export function useChatController({ user, route, currentRoom, roomServerIds, roomHistory, setRoomHistory, markRead }: {
  markRead(roomId: string, throughSequence: number): Promise<void>;
  user: PublicUser | null;
  route: Route;
  currentRoom: RoomSummary | undefined;
  roomServerIds: RefObject<Record<string, string>>;
  roomHistory: ReturnType<typeof readRoomHistory>;
  setRoomHistory: Dispatch<SetStateAction<ReturnType<typeof readRoomHistory>>>;
}) {
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, ChatMessage[]>>({});
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
    setLoadedWatermarks(current => { const next = { ...current }; delete next[route.roomId]; return next; });
    fetchMessages(route.roomId).then((response) => {
      if (mounted) {
        loadedAccountsRef.current.set(route.roomId, user.id);
        setMessagesByRoom((current) => ({ ...current, [route.roomId]: (current[route.roomId] ?? []).filter(message => message.sequence > response.readThroughSequence).reduce(upsertMessage, response.messages) }));
        setLoadedWatermarks(current => ({ ...current, [route.roomId]: Math.max(response.readThroughSequence, latestDeliveredRef.current[route.roomId] ?? 0) }));
      }
    }).catch(() => { if (mounted) setMessagesByRoom((current) => ({ ...current, [route.roomId]: [] })); });
    return () => { mounted = false; };
  }, [currentRoom, route, user]);

  useEffect(() => {
    setMessagesByRoom({}); setLoadedWatermarks({}); readCursorsRef.current = {}; latestDeliveredRef.current = {}; loadedAccountsRef.current.clear();
  }, [user?.id]);
  useEffect(() => {
    const resume = () => setFocusRevision(value => value + 1);
    window.addEventListener("focus", resume); document.addEventListener("visibilitychange", resume);
    return () => { window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
  }, []);
  useEffect(() => {
    if (!user || route.name !== "text" || currentRoom?.id !== route.roomId) return;
    const through = loadedWatermarks[route.roomId];
    if (!canMarkRoomRead({ loaded: through !== undefined && loadedAccountsRef.current.get(route.roomId) === user.id, visible: document.visibilityState === "visible", focused: document.hasFocus() })
      || through <= (readCursorsRef.current[route.roomId] ?? -1)) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void markRead(route.roomId, through).then(() => {
      if (!disposed) readCursorsRef.current[route.roomId] = Math.max(readCursorsRef.current[route.roomId] ?? 0, through);
    }).catch(() => { if (!disposed) retry = setTimeout(() => setFocusRevision(value => value + 1), 5_000); });
    return () => { disposed = true; clearTimeout(retry); };
  }, [user?.id, route, currentRoom?.id, loadedWatermarks, focusRevision, markRead]);

  const updateOutbox = (roomId: string, update: (entries: OutboxEntry[]) => OutboxEntry[]) => {
    setOutboxByRoom((current) => ({ ...current, [roomId]: update(current[roomId] ?? []) }));
  };

  const applyMessage = (message: ChatMessage, unread = false) => {
    setMessagesByRoom((current) => ({ ...current, [message.roomId]: upsertMessage(current[message.roomId] ?? [], message) }));
    if (unread) latestDeliveredRef.current[message.roomId] = Math.max(latestDeliveredRef.current[message.roomId] ?? 0, message.sequence);
    if (unread && message.roomId === activeTextRoomIdRef.current) setLoadedWatermarks(current => current[message.roomId] === undefined ? current
      : { ...current, [message.roomId]: Math.max(current[message.roomId], message.sequence) });
  };

  return {
    messagesByRoom, roomHistory, activeTextRoomIdRef,
    applyNewMessage: (message: ChatMessage) => applyMessage(message, true),
    applyUpdatedMessage: (message: ChatMessage) => applyMessage(message),
    applyDeletedMessage: (roomId: string, messageId: string) => setMessagesByRoom((current) => ({ ...current, [roomId]: (current[roomId] ?? []).filter((message) => message.id !== messageId) })),
    applyMemberRename: (serverId: string, next: PresenceUser) => setMessagesByRoom((current) => renameMessagesForServer(current, roomServerIds.current, serverId, next)),
    applyMemberDeletion: (serverId: string, userId: string) => setMessagesByRoom((current) => anonymizeMessagesForServer(current, roomServerIds.current, serverId, userId)),
    outboxByRoom,
    actionsForRoom: (roomId: string) => {
      // Never rejects: a failed send is reported on its own outbox row so the
      // composer stays usable and the text is not lost.
      const deliver = async (entry: OutboxEntry) => {
        try {
          const response = await sendMessage(roomId, entry.body, entry.replyTo?.messageId ?? null);
          updateOutbox(roomId, (entries) => removeOutboxEntry(entries, entry.localId));
          applyMessage(response.message);
        } catch {
          updateOutbox(roomId, (entries) => setOutboxEntryStatus(entries, entry.localId, "failed"));
        }
      };
      const enqueue = (entry: OutboxEntry) => {
        const chain = (sendChainsRef.current[roomId] ?? Promise.resolve()).then(() => deliver(entry));
        sendChainsRef.current[roomId] = chain;
      };
      return {
        send: (body: string, replyTo: ChatMessageReply | null = null) => {
          const entry: OutboxEntry = {
            localId: crypto.randomUUID(),
            body,
            createdAt: new Date().toISOString(),
            status: "pending",
            replyTo
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
        update: async (messageId: string, body: string) => { const response = await updateMessage(roomId, messageId, body); applyMessage(response.message); },
        delete: async (messageId: string) => { await deleteMessage(roomId, messageId); setMessagesByRoom((current) => ({ ...current, [roomId]: (current[roomId] ?? []).filter((message) => message.id !== messageId) })); },
        suppressEmbed: async (messageId: string, embedKey: string) => { const response = await suppressMessageEmbed(roomId, messageId, embedKey); applyMessage(response.message); }
      };
    }
  };
}
