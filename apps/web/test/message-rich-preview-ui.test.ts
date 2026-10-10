import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readAppSource } from "./app-source.js";

describe("message rich previews", () => {
  it("renders safe links and allowlisted provider frames without raw HTML", () => {
    const app = readAppSource();
    const message = app.match(/function\s+MessageItem[\s\S]*?\n}\n\nfunction\s+FatalState/)?.[0] ?? "";

    assert.match(message, /<MessageBody\s+body=\{message\.body\}/);
    const body = readFileSync("src/features/chat/MessageBody.tsx", "utf8");
    assert.match(body, /messageContentSegments\(piece\.text\)/);
    assert.match(body, /rel="noopener\s+noreferrer"/);
    assert.match(message, /messageEmbeds\(message\.body,\s+message\.suppressedEmbedKeys\)/);
    assert.match(message, /target="_blank"/);
    assert.match(message, /rel="noopener\s+noreferrer"/);
    assert.match(message, /<iframe/);
    assert.match(message, /sandbox=/);
    assert.doesNotMatch(message, /dangerouslySetInnerHTML/);
  });

  it("shows a confirmed per-embed close action only to authors and owners", () => {
    const app = readAppSource();
    const message = app.match(/function\s+MessageItem[\s\S]*?\n}\n\nfunction\s+FatalState/)?.[0] ?? "";

    assert.match(message, /permissions\.canDelete/);
    assert.match(message, /setPendingEmbed/);
    assert.match(message, /room\.suppressEmbedTitle/);
    assert.match(message, /onSuppressEmbed/);
    assert.match(app, /suppressMessageEmbed/);
  });
});
