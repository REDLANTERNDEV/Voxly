import type { NotificationStateResponse, ServerNotificationState } from "@voxly/shared";
export function serverNotificationsMuted(state: ServerNotificationState | undefined, now = Date.now()) {
  return state?.mute.mode === "indefinite" || (state?.mute.mode === "until" && Date.parse(state.mute.until) > now);
}
export function serverUnreadCount(state: ServerNotificationState | undefined, now = Date.now()) {
  return serverNotificationsMuted(state, now)
    ? 0
    : (state?.rooms.reduce((total, room) => total + room.unreadCount, 0) ?? 0);
}
export function unreadBadge(count: number) {
  return count > 9 ? "9+" : String(count);
}
export function unreadRooms(snapshot: NotificationStateResponse | null) {
  return Object.fromEntries(
    snapshot?.servers.flatMap((server) => server.rooms.map((room) => [room.roomId, room.unreadCount])) ?? []
  );
}
export function canMarkRoomRead(input: { loaded: boolean; visible: boolean; focused: boolean }) {
  return input.loaded && input.visible && input.focused;
}
