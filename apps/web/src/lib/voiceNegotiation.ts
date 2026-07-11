export function shouldOfferToJoiningMember(currentUserId: string, peerUserId: string, joiningUserId: string) {
  return currentUserId !== joiningUserId && peerUserId === joiningUserId;
}

export type PeerConnectionState = "new" | "connecting" | "connected" | "failed";
export type VisualConnectionStatus = "connecting" | "failed" | "ready";

export function connectionStatusFor(state: PeerConnectionState, hasStream: boolean): VisualConnectionStatus {
  if (hasStream) return "ready";
  return state === "failed" ? "failed" : "connecting";
}
