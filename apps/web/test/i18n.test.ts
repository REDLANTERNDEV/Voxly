import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectLanguage, languageLabel, resolveLanguageChoice, translate } from "../src/lib/i18n.js";

describe("frontend localization", () => {
  it("detects Turkish from the browser language list", () => {
    assert.equal(detectLanguage(["de-DE", "tr-TR", "en-US"]), "tr");
  });

  it("prefers a saved manual language over browser detection", () => {
    assert.equal(resolveLanguageChoice("en", ["tr-TR"]), "en");
  });

  it("falls back to English for unsupported browser languages", () => {
    assert.equal(resolveLanguageChoice(null, ["nl-NL", "fr-FR"]), "en");
  });

  it("translates known UI labels in both supported languages", () => {
    assert.equal(translate("tr", "common.send"), "Gönder");
    assert.equal(translate("en", "common.send"), "Send");
    assert.equal(languageLabel("tr"), "Türkçe");
  });

  it("translates personal and screen-share volume labels", () => {
    assert.equal(translate("en", "voice.memberVolume", { nickname: "Ada" }), "Ada volume");
    assert.equal(translate("tr", "voice.screenVolume"), "Yayın sesi");
    assert.equal(translate("tr", "voice.noScreenAudio"), "Bu paylaşımda ses yok");
  });

  it("translates blocked audio recovery copy", () => {
    assert.equal(translate("en", "audio.enablePlayback"), "Enable audio");
    assert.equal(translate("tr", "audio.enablePlayback"), "Sesi etkinleştir");
    assert.equal(translate("tr", "audio.playbackBlocked"), "Tarayıcı gelen sesi duraklattı.");
  });

  it("keeps the landing invitation concise in both languages", () => {
    assert.equal(translate("en", "landing.title"), "A room for your people");
    assert.equal(translate("tr", "landing.title"), "Kendi grubun için bir oda");
    assert.equal(translate("tr", "landing.inviteCta"), "Davetle katıl");
  });
});
