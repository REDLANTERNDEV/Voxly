export type VoiceChannelActivation = "open" | "join" | "confirm-move";

export function voiceChannelActivation(activeRoomId: string | null, targetRoomId: string): VoiceChannelActivation {
  if (!activeRoomId) return "join";
  return activeRoomId === targetRoomId ? "open" : "confirm-move";
}
