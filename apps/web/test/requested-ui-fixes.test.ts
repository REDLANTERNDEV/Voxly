import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readAppSource } from "./app-source.js";

describe("requested UI fixes", () => {
  it("uses localized date-aware message timestamps", () => {
    const app = readAppSource();
    const message = app.match(/function MessageItem[\s\S]*?\n}\n\nfunction FatalState/)?.[0] ?? "";

    assert.match(message, /formatMessageTimestamp\(message\.createdAt, language\)/);
  });

  it("keeps room-derived rendering and owner chat links scoped to the active server", () => {
    const app = readAppSource();
    const owner = app.match(/function OwnerPanel[\s\S]*?\n}\n\nfunction AppChrome/)?.[0] ?? "";

    assert.match(app, /roomsForServer\(rooms, activeServerId\)/);
    assert.match(owner, /ownerChatPath/);
    assert.doesNotMatch(owner, /serverPath\(props\.activeServerId, "text", "general"\)/);
  });

  it("hides the left voice-row ellipsis from a mouse while preserving row context and keyboard menus", () => {
    const app = readAppSource();
    const rail = app.match(/function ChannelRail[\s\S]*?\n}\n\nfunction ChannelDeleteControl/)?.[0] ?? "";
    const styles = readFileSync("src/styles.css", "utf8");

    assert.match(rail, /onContextMenu=/);
    assert.match(rail, /onKeyDown=/);
    // The trigger is rendered on every device and taken away by CSS, because a
    // touchscreen has no secondary click, no Context Menu key and no Shift+F10.
    assert.doesNotMatch(rail, /showTrigger=/);
    assert.match(styles, /\.voice-channel-user \.sidebar-menu-trigger \{\s*display: none;/);
    assert.match(
      styles,
      /@media \(pointer: coarse\) \{[\s\S]*?\.voice-channel-user \.sidebar-menu-trigger \{\s*display: inline-flex;/
    );
  });

  it("masks owner secrets behind an accessible reveal control", () => {
    const app = readAppSource();
    const owner = app.match(/function OwnerPanel[\s\S]*?\n}\n\nfunction AppChrome/)?.[0] ?? "";

    assert.match(app, /function SecretLinkDisplay/);
    assert.match(owner, /<SecretLinkDisplay/);
    assert.match(app, /owner\.revealLink/);
    assert.match(app, /owner\.hideLink/);
  });
});
