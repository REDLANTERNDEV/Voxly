import type { ChatMessage,PresenceUser,PublicUser,RoomSummary } from "@voxly/shared";
import { useEffect,useRef,useState,type Dispatch,type RefObject,type SetStateAction } from "react";
import { deleteMessage,fetchMessages,sendMessage,suppressMessageEmbed,updateMessage } from "../../api.js";
import { upsertMessage } from "../../app/presentation.js";
import type { Route } from "../../app/types.js";
import { clearUnread,readRoomHistory,rememberRoom,unreadAfterMessage,writeRoomHistory } from "../../lib/channelState.js";
import { renameMessagesForServer } from "../../lib/memberIdentity.js";

export function useChatController({ user, route, currentRoom, roomServerIds, roomHistory, setRoomHistory }: {
  user: PublicUser | null;
  route: Route;
  currentRoom: RoomSummary | undefined;
  roomServerIds: RefObject<Record<string, string>>;
  roomHistory: ReturnType<typeof readRoomHistory>;
  setRoomHistory: Dispatch<SetStateAction<ReturnType<typeof readRoomHistory>>>;
}) {
  const [messagesByRoom, setMessagesByRoom] = useState<Record<string, ChatMessage[]>>({});
  const [unreadByRoom, setUnreadByRoom] = useState<Record<string, number>>({});
  const activeTextRoomIdRef = useRef<string | null>(route.name === "text" ? route.roomId : null);

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
    actionsForRoom: (roomId: string) => ({
      send: async (body: string) => { const response = await sendMessage(roomId, body); applyMessage(response.message); },
      update: async (messageId: string, body: string) => { const response = await updateMessage(roomId, messageId, body); applyMessage(response.message); },
      delete: async (messageId: string) => { await deleteMessage(roomId, messageId); setMessagesByRoom((current) => ({ ...current, [roomId]: (current[roomId] ?? []).filter((message) => message.id !== messageId) })); },
      suppressEmbed: async (messageId: string, embedKey: string) => { const response = await suppressMessageEmbed(roomId, messageId, embedKey); applyMessage(response.message); }
    })
  };
}
