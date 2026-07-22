import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("requested UI fixes", () => {
  it("uses localized date-aware message timestamps", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const message = app.match(/function MessageItem[\s\S]*?\n}\n\nfunction FatalState/)?.[0] ?? "";

    assert.match(message, /formatMessageTimestamp\(message\.createdAt, language\)/);
  });

  it("keeps room-derived rendering and owner chat links scoped to the active server", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const owner = app.match(/function OwnerPanel[\s\S]*?\n}\n\nfunction AppChrome/)?.[0] ?? "";

    assert.match(app, /roomsForServer\(rooms, activeServerId\)/);
    assert.match(owner, /ownerChatPath/);
    assert.doesNotMatch(owner, /serverPath\(props\.activeServerId, "text", "general"\)/);
  });

  it("removes the left voice-row ellipsis while preserving row context and keyboard menus", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const rail = app.match(/function ChannelRail[\s\S]*?\n}\n\nfunction ChannelDeleteControl/)?.[0] ?? "";

    assert.match(rail, /onContextMenu=/);
    assert.match(rail, /onKeyDown=/);
    assert.match(rail, /<MemberActionMenu[\s\S]*?showTrigger=\{false\}/);
  });

  it("masks owner secrets behind an accessible reveal control", () => {
    const app = readFileSync("src/App.tsx", "utf8");
    const owner = app.match(/function OwnerPanel[\s\S]*?\n}\n\nfunction AppChrome/)?.[0] ?? "";

    assert.match(app, /function SecretLinkDisplay/);
    assert.match(owner, /<SecretLinkDisplay/);
    assert.match(app, /owner\.revealLink/);
    assert.match(app, /owner\.hideLink/);
  });
});
