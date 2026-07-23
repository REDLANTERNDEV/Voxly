export function joinVoiceWithAudioUnlock(
  roomId: string,
  unlock: () => void,
  release: () => void,
  join: (roomId: string) => Promise<boolean>
) {
  unlock();
  return join(roomId).then((joined) => {
    if (!joined) release();
    return joined;
  }, (cause: unknown) => {
    release();
    throw cause;
  });
}
