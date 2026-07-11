export function shouldInitiatePeerConnection(currentUserId: string, peerUserId: string) {
  return currentUserId !== peerUserId && currentUserId < peerUserId;
}

export type PeerConnectionState = "new" | "connecting" | "connected" | "failed";
export type VisualConnectionStatus = "connecting" | "failed" | "ready";

export function connectionStatusFor(state: PeerConnectionState, hasStream: boolean): VisualConnectionStatus {
  if (hasStream) return "ready";
  return state === "failed" ? "failed" : "connecting";
}
