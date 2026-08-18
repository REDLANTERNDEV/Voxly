import type { ChatMessage,ChatMessageReply,PresenceUser,PublicUser,RoomSummary } from "@voxly/shared";
import { useEffect,useRef,useState,type Dispatch,type RefObject,type SetStateAction } from "react";
import { deleteMessage,fetchMessages,sendMessage,suppressMessageEmbed,updateMessage } from "../../api.js";
import { upsertMessage } from "../../app/presentation.js";
import type { Route } from "../../app/types.js";
import { clearUnread,readRoomHistory,rememberRoom,unreadAfterMessage,writeRoomHistory } from "../../lib/channelState.js";
import { renameMessagesForServer } from "../../lib/memberIdentity.js";
import { appendOutboxEntry,removeOutboxEntry,setOutboxEntryStatus,type OutboxEntry } from "../../lib/messageOutbox.js";

export function useChatController({ user, route, currentRoom, roomServerIds, roomHistory, setRoomHistory }: {
  user: PublicUser | null;
  route: Route;
  currentRoom: RoomSummary | undefined;
  roomServerIds: RefObject<Record<string, string>>;
  roomHistory: ReturnType<typeof readRoomHistory>;
  setRoomHistory: Dispatch<SetStateAction<ReturnType<typeof readRoomHistory>>>;
}) {
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, ChatMessage[]>>({});
  const [outboxByRoom, setOutboxByRoom] = useState<Record<string, OutboxEntry[]>>({});
  const [unreadByRoom, setUnreadByRoom] = useState<Record<string, number>>({});
  const activeTextRoomIdRef = useRef<string | null>(route.name === "text" ? route.roomId : null);
  // One chain per room keeps deliveries serial, so messages land in the order
  // they were composed even though the composer no longer waits for each one.
  const sendChainsRef = useRef<Record<string, Promise<void>>>({});

  useEffect(() => {
    activeTextRoomIdRef.current = route.name === "text" ? route.roomId : null;
    if (route.name !== "text" && route.name !== "voice") return;
    if (route.name === "text") setUnreadByRoom((current) => clearUnread(current, route.roomId));
    setRoomHistory((current) => {
      const next = rememberRoom(current, route.serverId, route.name, route.roomId);
      writeRoomHistory(window.localStorage, next);
      return next;
    });
  }, [route]);

  useEffect(() => {
    if (!user || route.name !== "text" || currentRoom?.kind !== "text") return;
    let mounted = true;
    fetchMessages(route.roomId).then((response) => {
      if (mounted) setMessagesByRoom((current) => ({ ...current, [route.roomId]: response.messages }));
    }).catch(() => { if (mounted) setMessagesByRoom((current) => ({ ...current, [route.roomId]: [] })); });
    return () => { mounted = false; };
  }, [currentRoom, route, user]);

  const updateOutbox = (roomId: string, update: (entries: OutboxEntry[]) => OutboxEntry[]) => {
    setOutboxByRoom((current) => ({ ...current, [roomId]: update(current[roomId] ?? []) }));
  };

  const applyMessage = (message: ChatMessage, unread = false) => {
    setMessagesByRoom((current) => ({ ...current, [message.roomId]: upsertMessage(current[message.roomId] ?? [], message) }));
    if (unread && user) setUnreadByRoom((current) => unreadAfterMessage(current, message, activeTextRoomIdRef.current, user.id));
  };

  return {
    messagesByRoom, unreadByRoom, roomHistory, activeTextRoomIdRef,
    applyNewMessage: (message: ChatMessage) => applyMessage(message, true),
    applyUpdatedMessage: (message: ChatMessage) => applyMessage(message),
    applyDeletedMessage: (roomId: string, messageId: string) => setMessagesByRoom((current) => ({ ...current, [roomId]: (current[roomId] ?? []).filter((message) => message.id !== messageId) })),
    applyMemberRename: (serverId: string, next: PresenceUser) => setMessagesByRoom((current) => renameMessagesForServer(current, roomServerIds.current, serverId, next)),
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
