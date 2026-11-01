import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { translate, type TranslationKey } from "../src/lib/i18n.js";

const dialog = readFileSync("src/components/shell/ProfileDialog.tsx", "utf8");
const chrome = readFileSync("src/components/shell/AppChrome.tsx", "utf8");
const settings = readFileSync("src/components/shell/SettingsDialog.tsx", "utf8");

describe("Profile dialog", () => {
  it("is a native modal of its own, rendered beside Settings and never inside it", () => {
    assert.match(dialog, /\.showModal\(\)/);
    assert.match(dialog, /createPortal\(/);
    assert.doesNotMatch(settings, /ProfileDialog/);
    const settingsAt = chrome.indexOf("<SettingsDialog");
    const profileAt = chrome.indexOf("<ProfileDialog");
    assert.ok(settingsAt >= 0 && profileAt > settingsAt, "ProfileDialog renders after Settings, as its sibling");
  });

  it("answers Escape itself, so Settings stays open beneath it", () => {
    assert.match(dialog, /event\.key\s+!==\s+"Escape"\)\s+return;\s*event\.preventDefault\(\);\s*requestClose\(\);/);
    assert.match(dialog, /onCancel=\{\(event\)\s+=>\s+\{\s*event\.preventDefault\(\);\s*requestClose\(\);/);
    assert.match(settings, /event\.key\s+===\s+"Escape"\s+&&\s+!event\.defaultPrevented/);
  });

  it("refuses every close while anything is unsaved, and says so on the bar", () => {
    const requestClose = dialog.match(/const requestClose = \(\) => \{[\s\S]*?\n {2}\};/)?.[0] ?? "";
    assert.match(requestClose, /if \(saving\) return;/);
    assert.match(requestClose, /if \(dirty\) \{\s*alertUnsaved\(\);\s*return;\s*\}/);
    assert.match(requestClose, /onClose\(\);/);
    assert.match(dialog, /onClick=\{requestClose\}/, "the close button goes through the guard");
    assert.match(dialog, /event\.target === dialogRef\.current\) requestClose\(\)/, "so does the backdrop");
    assert.match(dialog, /prefers-reduced-motion: reduce/, "the shake gives way to reduced motion");
    assert.match(dialog, /className=\{`profile-unsaved \$\{blocked \? "is-blocked" : ""\}`\}\s+hidden=\{!dirty\}/);
  });

  it("is reached from Settings as a dialog, not as a section", () => {
    assert.match(
      settings,
      /className="settings-nav-item settings-nav-profile"[\s\S]*?aria-haspopup="dialog"[\s\S]*?onClick=\{props\.onOpenProfile\}/
    );
    assert.match(settings, /<ExternalLinkIcon \/>/);
  });

  it("words the dialog in both languages, without em dashes", () => {
    const keys: TranslationKey[] = [
      "shell.editProfile",
      "settings.profile",
      "profile.title",
      "profile.accountNickname",
      "profile.accountNicknameHint",
      "profile.serverNicknames",
      "profile.serverNicknamesHint",
      "profile.nicknameFor",
      "profile.clearNickname",
      "profile.unsaved",
      "profile.unsavedBlocked",
      "profile.reset",
      "profile.save",
      "profile.loadFailed",
      "profile.noServers",
      "category.createChannelIn"
    ];
    for (const key of keys) {
      assert.notEqual(translate("en", key), translate("tr", key), key);
      for (const language of ["en", "tr"] as const) {
        assert.doesNotMatch(translate(language, key), /—/, `${language} ${key}`);
      }
    }
  });
});
