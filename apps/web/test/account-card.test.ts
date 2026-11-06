import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountCard } from "../src/components/shell/AccountCard.js";
import { translate, type TranslationKey } from "../src/lib/i18n.js";

function render(overrides: Partial<Parameters<typeof AccountCard>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(AccountCard, {
      menuRef: createRef<HTMLDetailsElement>(),
      nickname: "Ada",
      mentionCode: "A7K2X9",
      roles: [],
      isOwner: false,
      selfState: "dnd",
      presenceChoice: { status: "dnd", until: null },
      language: "en",
      timeFormat: "24",
      t: (key: TranslationKey, values?: Record<string, string | number>) => translate("en", key, values),
      ownerPanelHref: null,
      onPresenceChoiceChange: () => undefined,
      onNavigate: () => undefined,
      onOpenSettings: () => undefined,
      onEditProfile: () => undefined,
      onLogout: () => undefined,
      ...overrides
    })
  );
}

describe("account card", () => {
  it("leads with who you are in this Server", () => {
    const markup = render({ isOwner: true });
    assert.match(markup, /account-card-head[\s\S]*?presence-dot is-dnd[\s\S]*?<strong>Ada<\/strong>[\s\S]*?#A7K2X9/);
    assert.match(markup, /account-card-badge">Owner</);
    assert.doesNotMatch(render(), /account-card-badge/);
  });

  it("puts Status, Edit profile and Settings first, and signing out last", () => {
    const markup = render({ ownerPanelHref: "/app/server/s1/owner" });
    const order = ["account-status-row", "Edit profile", "Settings", "Owner panel", "Copy mention code", "Log Out"].map(
      (text) => markup.indexOf(text)
    );
    assert.ok(
      order.every((index) => index >= 0),
      String(order)
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order
    );
    assert.match(markup, /account-card-row is-danger[\s\S]*?Log Out/);
    assert.match(markup, /aria-haspopup="dialog"[^>]*>[\s\S]*?Edit profile/);
  });

  it("leaves out what a member without them cannot use", () => {
    const markup = render({ mentionCode: undefined });
    assert.doesNotMatch(markup, /Copy mention code/);
    assert.doesNotMatch(markup, /Owner panel/);
  });

  it("words the card in both languages", () => {
    for (const key of [
      "shell.copyMentionCode",
      "shell.mentionCodeCopied",
      "shell.mentionCodeCopyFailed",
      "shell.editProfile"
    ] as const) {
      assert.notEqual(translate("en", key), translate("tr", key), key);
    }
  });
});
