export function shouldInitiatePeerConnection(currentUserId: string, peerUserId: string) {
  return currentUserId !== peerUserId && currentUserId < peerUserId;
}

export function staleVoicePeerUserIds(
  peerUserIds: Iterable<string>,
  activeMemberUserIds: Iterable<string>
) {
  const activeMemberIds = new Set(activeMemberUserIds);
  return [...peerUserIds].filter((peerUserId) => !activeMemberIds.has(peerUserId));
}

export function shouldIgnoreIncomingOffer(
  currentUserId: string,
  peerUserId: string,
  signalingState: RTCSignalingState,
  makingOffer: boolean
) {
  const hasOfferCollision = makingOffer || signalingState !== "stable";
  const isPolitePeer = currentUserId > peerUserId;
  return hasOfferCollision && !isPolitePeer;
}

export type PeerConnectionState = "new" | "connecting" | "connected" | "failed";
export type VisualConnectionStatus = "connecting" | "failed" | "ready";

export function connectionStatusFor(state: PeerConnectionState, hasStream: boolean): VisualConnectionStatus {
  if (hasStream) return "ready";
  return state === "failed" ? "failed" : "connecting";
}
