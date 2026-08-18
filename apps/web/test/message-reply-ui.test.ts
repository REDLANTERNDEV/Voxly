import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { translate } from "../src/lib/i18n.js";

const messageItem = readFileSync("src/features/chat/MessageItem.tsx", "utf8");
const textRoom = readFileSync("src/features/chat/TextRoomScreen.tsx", "utf8");
const replyQuote = readFileSync("src/features/chat/ReplyQuote.tsx", "utf8");
const styles = readFileSync("src/styles.css", "utf8");

describe("message reply affordances", () => {
  it("offers reply from the hover control and the context menu alike", () => {
    assert.match(messageItem, /className="message-reply-trigger"[\s\S]*?onClick=\{\(\) => onReply\(message\)\}/);
    assert.match(messageItem, /<button role="menuitem" type="button" onClick=\{\(\) => \{\s*\n\s*setMenuPosition\(null\);\s*\n\s*onReply\(message\);/);
  });

  it("gives every reader the menu, since anyone who can read a message can answer it", () => {
    assert.match(messageItem, /const hasActions = true;/);
    // The menu must still grow and shrink with the permission-gated entries.
    assert.match(messageItem, /menuHeight: 50 \+ \(permissions\.canEdit \? 42 : 0\) \+ \(permissions\.canDelete \? 42 : 0\)/);
  });

  it("reveals the reply control on the same hover and touch rules as the ellipsis", () => {
    assert.match(styles, /\.message:hover \.message-reply-trigger,[\s\S]*?opacity: 1;/);
    assert.match(styles, /@media \(pointer: coarse\) \{[\s\S]*?\.message-reply-trigger,[\s\S]*?opacity: 1;/);
  });
});

describe("reply quote", () => {
  it("says the original is gone rather than hiding that the message is a reply", () => {
    assert.match(replyQuote, /if \(!reply\) \{\s*\n\s*return <p className="reply-quote is-missing">\{t\("room\.replyDeleted"\)\}<\/p>;/);
    // The strip is rendered from the id, so a deleted target still shows one.
    assert.match(messageItem, /message\.replyToMessageId \? \(\s*\n\s*<ReplyQuote reply=\{message\.replyTo\}/);
  });

  it("is only actionable where there is somewhere to jump to", () => {
    assert.match(replyQuote, /if \(!onJump\) \{/);
    assert.match(messageItem, /<ReplyQuote reply=\{message\.replyTo\} t=\{t\} onJump=\{onJumpToMessage\} \/>/);
    // The composer strip and unsent rows quote without a jump target.
    assert.match(textRoom, /<ReplyQuote reply=\{replyTarget\} t=\{props\.t\} \/>/);
  });

  it("clips the excerpt to one line so it cannot compete with the message", () => {
    assert.match(styles, /\.reply-quote-body \{[^}]*white-space: nowrap/);
    assert.match(styles, /\.reply-quote-body \{[^}]*text-overflow: ellipsis/);
  });
});

describe("reply composition", () => {
  it("carries the pending target into the send and clears it afterwards", () => {
    assert.match(textRoom, /props\.onSendMessage\(body, replyTarget\);\s*\n\s*setReplyTarget\(null\);/);
  });

  it("focuses the composer when a reply starts, so typing continues uninterrupted", () => {
    assert.match(textRoom, /function startReply\(message: ChatMessage\) \{[\s\S]*?composerRef\.current\?\.focus\(\);/);
  });

  it("cancels a pending reply with Escape as well as the strip's own control", () => {
    assert.match(textRoom, /if \(event\.key === "Escape" && replyTarget\) \{[\s\S]*?setReplyTarget\(null\);/);
    assert.match(textRoom, /aria-label=\{props\.t\("room\.replyCancel"\)\}/);
  });

  it("marks the jump destination instead of only scrolling to it", () => {
    assert.match(textRoom, /target\.scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/);
    assert.match(textRoom, /target\.classList\.add\("is-jump-target"\)/);
    assert.match(messageItem, /data-message-id=\{message\.id\}/);
  });

  it("escapes the id before building the selector", () => {
    // Message ids are server-generated, but a selector built from data is a
    // selector-injection sink regardless of where the data came from.
    assert.match(textRoom, /CSS\.escape\(messageId\)/);
  });
});

describe("reply localization", () => {
  it("translates every reply string in both languages", () => {
    for (const key of ["room.reply", "room.replyCancel", "room.replyDeleted"] as const) {
      assert.notEqual(translate("en", key), translate("tr", key), `${key} is untranslated`);
      assert.ok(translate("tr", key).length > 0);
    }
    assert.equal(translate("en", "room.replyingTo", { nickname: "Deniz" }), "Replying to Deniz");
    assert.equal(translate("tr", "room.replyingTo", { nickname: "Deniz" }), "Deniz kişisine yanıt veriliyor");
  });
});
