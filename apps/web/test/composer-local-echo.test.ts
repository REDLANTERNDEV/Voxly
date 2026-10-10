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
    assert.match(
      textRoom,
      /setDraft\(\s*""\s*\);[\s\S]*?props\.onSendMessage\(\s*body,\s+replyTarget,\s+mentions\s*\);/
    );
    assert.doesNotMatch(textRoom, /await\s+props\.onSendMessage/);
  });

  it("never disables the composer or its send button while a message is in flight", () => {
    assert.doesNotMatch(textRoom, /isSending/);
    assert.doesNotMatch(textRoom, /<button\s+className="btn\s+btn-primary"\s+type="submit"\s+disabled/);
  });

  it("renders unacknowledged messages in the same list as delivered ones", () => {
    assert.match(textRoom, /props\.outbox\.map\(\s*\(\s*entry\s*\)\s+=>\s*\s+\(\s*\s*<PendingMessageItem/);
    assert.match(
      textRoom,
      /messageListIds\(\s*displayedMessages\.map\(\s*\(\s*message\s*\)\s+=>\s*\s+message\.id\s*\),\s+props\.outbox\s*\)/
    );
  });

  it("keeps the empty state until both delivered and pending messages are absent", () => {
    assert.match(textRoom, /displayedMessages\.length\s+===\s+0\s+&&\s+props\.outbox\.length\s+===\s+0/);
  });
});

describe("outbox delivery", () => {
  it("serializes deliveries per room so composed order survives a slow link", () => {
    assert.match(chatController, /sendChainsRef\s+=\s+useRef<Record<string,\s+Promise<void>\s*>\s*>\s*/);
    assert.match(
      chatController,
      /sendChainsRef\.current\[roomId\]\s+\?\?\s+Promise\.resolve\(\s*\s*\)\s*\)\.then\(\s*\(\s*\s*\)\s+=>\s*\s+deliver\(\s*entry\s*\)\s*\)/
    );
  });

  it("absorbs a delivery failure onto the entry rather than rejecting to the composer", () => {
    assert.match(
      chatController,
      /catch\s+\{\s*[\s\S]*?updateOutbox\(\s*roomId,\s+\(\s*entries\s*\)\s+=>\s*\s+setOutboxEntryStatus\(\s*entries,\s+entry\.localId,\s+"failed"\s*\)\s*\)/
    );
    assert.match(
      chatController,
      /send:\s+\(\s*body:\s+string,\s+replyTo:\s+ChatMessageReply\s+\|\s+null\s+=\s+null,\s+mentions:\s+MessageMention\[\]\s+=\s+\[\]\s*\)\s+=>\s*\s+\{\s*/
    );
  });

  it("drops the local echo only once the server answers, so the row is never duplicated", () => {
    assert.match(
      chatController,
      /const\s+response\s+=\s+await\s+sendMessage\([\s\S]*?\);[\s\S]*?updateOutbox\(\s*roomId,\s+\(\s*entries\s*\)\s+=>\s*removeOutboxEntry\(\s*entries,\s+entry\.localId\s*\)\s*\);\s*applyMessage\(\s*response\.message\s*\);/
    );
  });

  it("offers retry and discard only after a failure, and refuses to retry a pending entry", () => {
    assert.match(pendingItem, /hasFailed\s+\?\s+\(\s*\s*\n\s*<div\s+className="message-actions">\s*/);
    assert.match(chatController, /if\s+\(\s*!entry\s+\|\|\s+entry\.status\s+!==\s+"failed"\s*\)\s+return;/);
  });

  it("keeps edit, delete, and embed affordances off an unsent message", () => {
    assert.doesNotMatch(pendingItem, /onUpdate|onDelete|onSuppressEmbed|message-embed/);
  });
});
