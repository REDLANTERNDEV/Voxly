/**
 * Who offers, and who yields when both offer at once. Defined once in
 * `@voxly/shared` because every peer in a room applies them to the same pair of
 * user ids: two copies that drifted apart would produce calls that fail
 * silently, with each side certain the other was going to offer.
 */
export { shouldIgnoreIncomingOffer, shouldInitiatePeerConnection } from "@voxly/shared";

export function staleVoicePeerUserIds(
  peerUserIds: Iterable<string>,
  activeMemberUserIds: Iterable<string>
) {
  const activeMemberIds = new Set(activeMemberUserIds);
  return [...peerUserIds].filter((peerUserId) => !activeMemberIds.has(peerUserId));
}

export type PeerConnectionState = "new" | "connecting" | "connected" | "failed";
export type VisualConnectionStatus = "connecting" | "failed" | "ready";

export function connectionStatusFor(state: PeerConnectionState, hasStream: boolean): VisualConnectionStatus {
  if (hasStream) return "ready";
  return state === "failed" ? "failed" : "connecting";
}
