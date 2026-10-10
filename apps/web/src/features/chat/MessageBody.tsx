import type { MessageMention, PresenceUser } from "@voxly/shared";
import { useState } from "react";
import type { Translate } from "../../app/types.js";
import { messageContentSegments } from "../../lib/messageEmbeds.js";
import { ChatDialog } from "./ChatDialog.js";

export function MessageBody({
  body,
  mentions,
  members = [],
  onlineUsers = [],
  t,
  links = true,
  cards = true
}: {
  body: string;
  mentions: MessageMention[];
  members?: PresenceUser[];
  onlineUsers?: PresenceUser[];
  t: Translate;
  links?: boolean;
  cards?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pieces: Array<{ text: string; mention?: MessageMention }> = [];
  let offset = 0;
  for (const mention of mentions) {
    pieces.push({ text: body.slice(offset, mention.start) });
    pieces.push({ text: body.slice(mention.start, mention.end), mention });
    offset = mention.end;
  }
  pieces.push({ text: body.slice(offset) });
  const selected = members.find((member) => member.userId === selectedId);
  const selectedMention = mentions.find((mention) => mention.kind === "person" && mention.userId === selectedId);
  return (
    <>
      {pieces.map((piece, index) => {
        const mention = piece.mention;
        if (!mention)
          return links ? (
            messageContentSegments(piece.text).map((segment, segmentIndex) =>
              segment.kind === "link" ? (
                <a href={segment.href} target="_blank" rel="noopener noreferrer" key={`${index}:${segmentIndex}`}>
                  {segment.text}
                </a>
              ) : (
                <span key={`${index}:${segmentIndex}`}>{segment.text}</span>
              )
            )
          ) : (
            <span key={index}>{piece.text}</span>
          );
        const member =
          mention.kind === "person" ? members.find((person) => person.userId === mention.userId) : undefined;
        const deleted = mention.authorDeleted;
        const label =
          mention.kind !== "person"
            ? `@${mention.kind}`
            : deleted
              ? `@${t("common.deletedMember")}`
              : `@${member?.nickname ?? mention.nickname} · #${member?.mentionCode ?? mention.mentionCode}`;
        return mention.kind === "person" && !deleted && cards ? (
          <button type="button" className="message-mention" key={index} onClick={() => setSelectedId(mention.userId)}>
            {label}
          </button>
        ) : (
          <span className="message-mention" key={index}>
            {label}
          </span>
        );
      })}
      {selectedId && selectedMention && !selectedMention.authorDeleted ? (
        <ChatDialog title={t("chat.personCard")} t={t} onClose={() => setSelectedId(null)}>
          <p className="chat-person-name">{selected?.nickname ?? selectedMention.nickname}</p>
          <p className="mono">#{selected?.mentionCode ?? selectedMention.mentionCode}</p>
          <p>{selected ? t(selected.role === "owner" ? "chat.owner" : "chat.member") : t("chat.formerMember")}</p>
          <p>{t(onlineUsers.some((member) => member.userId === selectedId) ? "chat.online" : "chat.offline")}</p>
        </ChatDialog>
      ) : null}
    </>
  );
}
