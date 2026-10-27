import { useCallback, useEffect, useState } from "react";
import type { PresenceChoiceRequest, PresenceChoiceState } from "@voxly/shared";
import { presenceChoiceSilencesMessages } from "../lib/presenceChoice.js";
import type { VoxlySocket } from "../socket.js";

const online: PresenceChoiceState = { status: "online", until: null };

/**
 * The member's own Status, as the server last said it is.
 *
 * Nothing is applied optimistically: the server answers every connection and
 * every change with `presence:choice`, on every one of the member's tabs, and
 * it is also the one that ends a timed Status. Holding a local guess would only
 * create a second clock that could disagree with it.
 */
export function usePresenceChoice(socket: VoxlySocket | null) {
  const [choice, setChoiceState] = useState<PresenceChoiceState>(online);

  useEffect(() => {
    if (!socket) return;
    const onChoice = (state: PresenceChoiceState) => setChoiceState(state);
    socket.on("presence:choice", onChoice);
    return () => {
      socket.off("presence:choice", onChoice);
    };
  }, [socket]);

  const setChoice = useCallback(
    (request: PresenceChoiceRequest) => {
      socket?.emit("presence:setChoice", request, (response) => {
        if (response.ok) setChoiceState(response.state);
      });
    },
    [socket]
  );

  return {
    messagesSilenced: presenceChoiceSilencesMessages(choice.status),
    presentation: { presenceChoice: choice, onPresenceChoiceChange: setChoice }
  };
}
