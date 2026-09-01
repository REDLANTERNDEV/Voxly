import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { relativeDay } from "../src/components/DeviceSettings.js";
import { translate, type LanguageCode, type TranslationKey } from "../src/lib/i18n.js";

const translator = (language: LanguageCode) =>
  (key: TranslationKey, values?: Record<string, string | number>) => translate(language, key, values);

/**
 * The Device list is the detection half of ADR-0014 — linking a second Device
 * is only safe if a member can afterwards answer "was that me?". These pin the
 * two ways it stops answering that: an unreadable time, and a row whose sign-out
 * has quietly become available on the Device doing the asking.
 */
describe("device list", () => {
  const source = () => readFileSync("src/components/DeviceSettings.tsx", "utf8");

  it("says when a Device was last used, coarsely, in both languages", () => {
    const en = translator("en");
    const tr = translator("tr");
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();

    assert.equal(relativeDay(new Date().toISOString(), en), "today");
    assert.equal(relativeDay(threeDaysAgo, en), "3 days ago");
    assert.equal(relativeDay(threeDaysAgo, tr), "3 gün önce");
  });

  it("still says something when the stored time is unusable", () => {
    // Rows predating the column carry no timestamp, and a member still has to
    // be able to see and close them.
    assert.equal(relativeDay("not-a-date", translator("en")), "at an unknown time");
  });

  it("offers no sign-out on the Device doing the asking", () => {
    // Signing out the current Device is logging out, which already exists and
    // also has to clear the cookie. The server refuses it; the interface must
    // not offer it either.
    assert.match(source(), /device\.current \? null :/);
  });

  it("re-reads the list from the server rather than splicing the row out", () => {
    // A failed revocation must not leave a Device the member believes is gone.
    assert.match(source(), /await signOutDevice\([\s\S]{0,400}await load\(\)/);
    assert.doesNotMatch(source(), /setDevices\(\(/);
  });
});
