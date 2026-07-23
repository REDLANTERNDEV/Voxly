import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readAppSource } from "./app-source.js";

describe("message rich previews", () => {
  it("renders safe links and allowlisted provider frames without raw HTML", () => {
    const app = readAppSource();
    const message = app.match(/function MessageItem[\s\S]*?\n}\n\nfunction FatalState/)?.[0] ?? "";

    assert.match(message, /messageContentSegments\(message\.body\)/);
    assert.match(message, /messageEmbeds\(message\.body, message\.suppressedEmbedKeys\)/);
    assert.match(message, /target="_blank"/);
    assert.match(message, /rel="noopener noreferrer"/);
    assert.match(message, /<iframe/);
    assert.match(message, /sandbox=/);
    assert.doesNotMatch(message, /dangerouslySetInnerHTML/);
  });

  it("shows a confirmed per-embed close action only to authors and owners", () => {
    const app = readAppSource();
    const message = app.match(/function MessageItem[\s\S]*?\n}\n\nfunction FatalState/)?.[0] ?? "";

    assert.match(message, /permissions\.canDelete/);
    assert.match(message, /setPendingEmbed/);
    assert.match(message, /room\.suppressEmbedTitle/);
    assert.match(message, /onSuppressEmbed/);
    assert.match(app, /suppressMessageEmbed/);
  });
});
