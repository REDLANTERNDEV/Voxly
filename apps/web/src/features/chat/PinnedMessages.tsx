import type { ChatMessage, PresenceUser } from "@voxly/shared";
import { useEffect, useState } from "react";
import { fetchPinnedMessages } from "../../api.js";
import type { Translate } from "../../app/types.js";
import { ChatDialog } from "./ChatDialog.js";
import { MessageBody } from "./MessageBody.js";
import { reconcileMessageIdentity, type MemberIdentityChanges } from "../../lib/memberIdentity.js";

export function PinnedMessages({
  roomId,
  revision,
  identityChanges,
  members,
  t,
  onOpen,
  onClose
}: {
  roomId: string;
  revision: number;
  identityChanges: MemberIdentityChanges;
  members: PresenceUser[];
  t: Translate;
  onOpen(messageId: string): void;
  onClose(): void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const resolvedMessages = messages.map((message) => reconcileMessageIdentity(message, identityChanges));
  if (resolvedMessages.some((message, index) => message !== messages[index])) setMessages(resolvedMessages);
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(false);
    void fetchPinnedMessages(roomId)
      .then((response) => {
        if (mounted) setMessages(response.messages);
      })
      .catch(() => {
        if (mounted) setError(true);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [roomId, revision, retry, members]);
  return (
    <ChatDialog title={t("chat.pins")} t={t} onClose={onClose}>
      {loading ? <p role="status">{t("system.loadingVoxly")}</p> : null}
      {error ? (
        <div role="status">
          <p>{t("chat.actionFailed")}</p>
          <button className="btn btn-ghost" type="button" onClick={() => setRetry((value) => value + 1)}>
            {t("room.messageRetry")}
          </button>
        </div>
      ) : null}
      {!loading && !error && !messages.length ? <p>{t("chat.noPins")}</p> : null}
      <ul className="pinned-message-list">
        {messages.map((message) => {
          return (
            <li key={message.id}>
              <button type="button" onClick={() => onOpen(message.id)}>
                <strong>
                  {message.authorDeleted
                    ? t("common.deletedMember")
                    : (members.find((member) => member.userId === message.userId)?.nickname ?? message.nickname)}
                </strong>
                <span>
                  <MessageBody
                    body={message.body}
                    mentions={message.mentions}
                    members={members}
                    t={t}
                    links={false}
                    cards={false}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </ChatDialog>
  );
}
