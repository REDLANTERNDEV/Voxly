export interface MicrophoneTestDeafenLease {
  roomId: string;
  restoreDeafened: boolean;
}

export function claimMicrophoneTestDeafen(roomId: string, deafened: boolean) {
  return {
    lease: { roomId, restoreDeafened: deafened } satisfies MicrophoneTestDeafenLease,
    shouldDeafen: !deafened
  };
}

export function shouldRestoreMicrophoneTestDeafen(
  lease: MicrophoneTestDeafenLease | null,
  activeRoomId: string | null
) {
  return Boolean(lease && lease.roomId === activeRoomId && !lease.restoreDeafened);
}
