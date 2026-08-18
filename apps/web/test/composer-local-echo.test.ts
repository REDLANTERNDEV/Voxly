import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const textRoom = readFileSync("src/features/chat/TextRoomScreen.tsx", "utf8");
const chatController = readFileSync("src/features/chat/useChatController.ts", "utf8");
const pendingItem = readFileSync("src/features/chat/PendingMessageItem.tsx", "utf8");

describe("composer local echo", () => {
  it("clears the draft on submit instead of after the round trip", () => {
    // Regression: the draft used to survive until the POST resolved, so the
    // author could not tell an accepted message from a stalled one.
    assert.match(textRoom, /setDraft\(""\);\s*\n\s*props\.onSendMessage\(body, replyTarget\);/);
    assert.doesNotMatch(textRoom, /await props\.onSendMessage/);
  });

  it("never disables the composer or its send button while a message is in flight", () => {
    assert.doesNotMatch(textRoom, /isSending/);
    assert.doesNotMatch(textRoom, /<button className="btn btn-primary" type="submit" disabled/);
  });

  it("renders unacknowledged messages in the same list as delivered ones", () => {
    assert.match(textRoom, /props\.outbox\.map\(\(entry\) => \(\s*<PendingMessageItem/);
    assert.match(textRoom, /messageListIds\(props\.messages\.map\(\(message\) => message\.id\), props\.outbox\)/);
  });

  it("keeps the empty state until both delivered and pending messages are absent", () => {
    assert.match(textRoom, /props\.messages\.length === 0 && props\.outbox\.length === 0/);
  });
});

describe("outbox delivery", () => {
  it("serializes deliveries per room so composed order survives a slow link", () => {
    assert.match(chatController, /sendChainsRef = useRef<Record<string, Promise<void>>>/);
    assert.match(chatController, /sendChainsRef\.current\[roomId\] \?\? Promise\.resolve\(\)\)\.then\(\(\) => deliver\(entry\)\)/);
  });

  it("absorbs a delivery failure onto the entry rather than rejecting to the composer", () => {
    assert.match(chatController, /catch \{\s*updateOutbox\(roomId, \(entries\) => setOutboxEntryStatus\(entries, entry\.localId, "failed"\)\)/);
    assert.match(chatController, /send: \(body: string, replyTo: ChatMessageReply \| null = null\) => \{/);
  });

  it("drops the local echo only once the server answers, so the row is never duplicated", () => {
    assert.match(
      chatController,
      /const response = await sendMessage\(roomId, entry\.body, entry\.replyTo\?\.messageId \?\? null\);\s*\n\s*updateOutbox\(roomId, \(entries\) => removeOutboxEntry\(entries, entry\.localId\)\);\s*\n\s*applyMessage\(response\.message\);/
    );
  });

  it("offers retry and discard only after a failure, and refuses to retry a pending entry", () => {
    assert.match(pendingItem, /hasFailed \? \(\s*\n\s*<div className="message-actions">/);
    assert.match(chatController, /if \(!entry \|\| entry\.status !== "failed"\) return;/);
  });

  it("keeps edit, delete, and embed affordances off an unsent message", () => {
    assert.doesNotMatch(pendingItem, /onUpdate|onDelete|onSuppressEmbed|message-embed/);
  });
});
