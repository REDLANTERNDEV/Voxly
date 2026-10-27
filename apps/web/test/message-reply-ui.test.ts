import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { translate } from "../src/lib/i18n.js";

const messageItem = readFileSync("src/features/chat/MessageItem.tsx", "utf8");
const toolbar = readFileSync("src/features/chat/MessageToolbar.tsx", "utf8");
const textRoom = readFileSync("src/features/chat/TextRoomScreen.tsx", "utf8");
const replyQuote = readFileSync("src/features/chat/ReplyQuote.tsx", "utf8");
const styles = readFileSync("src/styles.css", "utf8");

describe("message reply affordances", () => {
  it("offers reply from the toolbar and the context menu alike", () => {
    assert.match(
      toolbar,
      /className="message-reply-trigger"[\s\S]*?aria-label=\{t\("room\.replyTo",\s*\{\s*nickname:\s*props\.nickname\s*\}\)\}[\s\S]*?onClick=\{props\.onReply\}/
    );
    assert.match(messageItem, /onReply=\{\(\)\s*=>\s*onReply\(message\)\}/);
    assert.match(
      messageItem,
      /<button\s+role="menuitem"\s+type="button"\s+onClick=\{\s*\(\s*\)\s+=>\s*\{\s*setMenuPosition\(\s*null\s*\);\s*onReply\(\s*message\s*\);/
    );
  });

  it("gives every reader the menu, since anyone who can read a message can answer it", () => {
    assert.match(messageItem, /const\s+hasActions\s+=\s+true;/);
    // The menu must still grow and shrink with the permission-gated entries.
    assert.match(
      messageItem,
      /menuHeight:\s+50\s+\+\s+\(\s*permissions\.canEdit\s+\?\s+42\s+:\s+0\s*\)\s+\+\s+\(\s*permissions\.canDelete\s+\?\s+42\s+:\s+0\s*\)/
    );
  });

  it("leads the menu with Copy, which reads the selection when the menu opens", () => {
    assert.match(
      messageItem,
      /function\s+openMenu[\s\S]*?setMenuSelection\(\s*articleRef\.current\s+\?\s+selectedTextIn\(/
    );
    assert.match(
      messageItem,
      /role="menu"[\s\S]*?\{isNotice\s+\?\s+null\s+:\s+\([\s\S]*?void\s+copyMessage\(\)[\s\S]*?menuSelection\s+\?\s+"chat\.copySelection"\s+:\s+"chat\.copyText"[\s\S]*?"room\.reply"/
    );
    assert.match(
      messageItem,
      /const\s+text\s+=\s+menuSelection\s+\|\|\s+bodyRef\.current\?\.innerText\s+\|\|\s+message\.body;/
    );
  });

  it("reacts from the toolbar and the menu, so touch and keyboard can react too", () => {
    assert.match(messageItem, /onOpenPicker=\{\(\)\s*=>\s*setPickerOpen\(true\)\}/);
    assert.match(
      messageItem,
      /"chat\.copyText"\)\}[\s\S]*?setPickerOpen\(true\);\s*\}\}\s*>\s*\{t\("chat\.addReactionPicker"\)\}/
    );
    assert.match(toolbar, /props\.quick\.map\(/);
    for (const key of ["chat.quickReact", "chat.quickUnreact", "chat.messageToolbar"] as const) {
      assert.notEqual(
        translate("en", key, { emoji: "🔥", nickname: "Ada" }),
        translate("tr", key, { emoji: "🔥", nickname: "Ada" })
      );
    }
  });

  it("floats the toolbar over the row on hover and focus, leaving the text its full width", () => {
    assert.match(styles, /\.message-toolbar\s+\{[^}]*opacity:\s+0;[^}]*position:\s+absolute;[^}]*top:\s+-16px;/);
    assert.match(
      styles,
      /\.message:hover\s+\.message-toolbar,\s*\.message:focus-within\s+\.message-toolbar,\s*\.message-toolbar:has\(\[aria-expanded="true"\]\)\s+\{\s*opacity:\s+1;/
    );
    assert.match(styles, /\.message-content\s+\{\s*max-width:\s+100%;/);
    assert.match(toolbar, /role="toolbar"/);
  });
});

describe("reply quote", () => {
  it("says the original is gone rather than hiding that the message is a reply", () => {
    assert.match(
      replyQuote,
      /if\s+\(\s*!reply\s*\)\s+\{\s*\s*\n\s*return\s+<p\s+className="reply-quote\s+is-missing">\s*\{\s*t\(\s*"room\.replyDeleted"\s*\)\s*\}<\/p>\s*;/
    );
    // The strip is rendered from the id, so a deleted target still shows one.
    assert.match(
      messageItem,
      /message\.replyToMessageId\s+\?\s+\(\s*\s*\n\s*<ReplyQuote\s+reply=\{\s*message\.replyTo\s*\}/
    );
  });

  it("is only actionable where there is somewhere to jump to", () => {
    assert.match(replyQuote, /if\s+\(\s*!onJump\s*\)\s+\{\s*/);
    assert.match(
      messageItem,
      /<ReplyQuote\s+reply=\{\s*message\.replyTo\s*\}\s+t=\{\s*t\s*\}\s+onJump=\{\s*onJumpToMessage\s*\}[^>]*\/>\s*/
    );
    // The composer strip and unsent rows quote without a jump target.
    assert.match(textRoom, /<ReplyQuote\s+reply=\{\s*replyTarget\s*\}\s+t=\{\s*props\.t\s*\}\s+hideAuthor[^>]*\/>\s*/);
  });

  it("clips the excerpt to one line so it cannot compete with the message", () => {
    assert.match(styles, /\.reply-quote-body\s+\{\s*[^}]*white-space:\s+nowrap/);
    assert.match(styles, /\.reply-quote-body\s+\{\s*[^}]*text-overflow:\s+ellipsis/);
  });
});

describe("reply composition", () => {
  it("names the author once in the composer strip", () => {
    // The strip's own copy already says whose message this answers, so the
    // quote beside it drops its author and only carries the excerpt.
    assert.match(textRoom, /composer-reply-target">\s*\{\s*props\.t\(\s*"room\.replyingTo"/);
    assert.match(textRoom, /hideAuthor/);
    assert.match(replyQuote, /const\s+author\s+=\s+hideAuthor\s+\?\s+null\s+:/);
  });

  it("carries the pending target into the send and clears it afterwards", () => {
    assert.match(
      textRoom,
      /props\.onSendMessage\(\s*body,\s+replyTarget,\s+mentions\s*\);\s*\n\s*setReplyTarget\(\s*null\s*\);/
    );
  });

  it("focuses the composer when a reply starts, so typing continues uninterrupted", () => {
    assert.match(
      textRoom,
      /function\s+startReply\(\s*message:\s+ChatMessage\s*\)\s+\{\s*[\s\S]*?composerRef\.current\?\.focus\(\s*\s*\);/
    );
  });

  it("cancels a pending reply with Escape as well as the strip's own control", () => {
    assert.match(textRoom, /onEscape=\{\s*\(\s*\s*\)\s+=>\s*\s+setReplyTarget\(\s*null\s*\)\s*\}/);
    assert.match(textRoom, /aria-label=\{\s*props\.t\(\s*"room\.replyCancel"\s*\)\s*\}/);
  });

  it("marks the jump destination instead of only scrolling to it", () => {
    assert.match(textRoom, /target\.scrollIntoView\(\s*\{\s*\s+behavior:\s+"smooth",\s+block:\s+"center"\s+\s*\}\s*\)/);
    assert.match(textRoom, /target\.classList\.add\(\s*"is-jump-target"\s*\)/);
    assert.match(messageItem, /data-message-id=\{\s*message\.id\s*\}/);
  });

  it("escapes the id before building the selector", () => {
    // Message ids are server-generated, but a selector built from data is a
    // selector-injection sink regardless of where the data came from.
    assert.match(textRoom, /CSS\.escape\(\s*messageId\s*\)/);
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
