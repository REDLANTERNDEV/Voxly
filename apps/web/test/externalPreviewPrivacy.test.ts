import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("external preview privacy UI", () => {
  it("does not create a provider iframe while its preference is off", () => {
    const source = readFileSync("src/features/chat/MessageItem.tsx", "utf8");

    assert.match(source, /previewEnabled \? <iframe/);
    assert.match(source, /externalPreviews\[embed\.provider\] \|\| revealedEmbedKeys\.has\(embed\.key\)/);
  });

  it("offers a room-lifecycle one-time reveal and privacy settings", () => {
    const room = readFileSync("src/features/chat/TextRoomScreen.tsx", "utf8");
    const message = readFileSync("src/features/chat/MessageItem.tsx", "utf8");

    assert.match(room, /setRevealedEmbeds\(new Set\(\)\)/);
    assert.match(message, /room\.previewShowOnce/);
    assert.match(message, /room\.previewSettings/);
  });

  it("offers plain-language controls to enable or disable every provider", () => {
    const settings = readFileSync("src/components/ExternalPreviewSettings.tsx", "utf8");

    assert.match(settings, /privacy\.enableAll/);
    assert.match(settings, /privacy\.disableAll/);
    assert.match(settings, /externalPreviewProviders\.every/);
  });

  it("discloses what the installation owner sees with a deletion request", () => {
    const translations = readFileSync("src/lib/i18n.ts", "utf8");

    assert.match(translations, /server names, effective nicknames, roles and membership states/);
    assert.match(translations, /sunucu adlarını, etkin takma adlarını, rollerini ve üyelik durumlarını/);
  });

  it("keeps Meta properties as ordinary links", () => {
    const embeds = readFileSync("src/lib/messageEmbeds.ts", "utf8");

    assert.doesNotMatch(embeds, /instagram|facebook|threads|meta\.com/iu);
  });
});
