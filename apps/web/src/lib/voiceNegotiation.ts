export function shouldOfferToJoiningMember(currentUserId: string, peerUserId: string, joiningUserId: string) {
  return currentUserId !== joiningUserId && peerUserId === joiningUserId;
}
