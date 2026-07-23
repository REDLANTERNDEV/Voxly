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

  it("localizes edited message timestamps", () => {
    assert.equal(translate("en", "room.editedAt", { time: "Jul 14, 2026, 3:34 PM" }), "Edited Jul 14, 2026, 3:34 PM");
    assert.equal(translate("tr", "room.editedAt", { time: "14 Tem 2026 15:34" }), "Düzenlendi: 14 Tem 2026 15:34");
  });

  it("translates personal and screen-share volume labels", () => {
    assert.equal(translate("en", "voice.memberVolume", { nickname: "Ada" }), "Ada volume");
    assert.equal(translate("tr", "voice.screenVolume"), "Yayın sesi");
    assert.equal(translate("tr", "voice.noScreenAudio"), "Bu paylaşımda ses yok");
  });

  it("translates server nickname editing in both languages", () => {
    assert.equal(translate("en", "member.changeNickname"), "Change nickname");
    assert.equal(translate("en", "member.nicknameLength"), "Use between 2 and 32 characters.");
    assert.equal(translate("tr", "member.changeNickname"), "Takma adı değiştir");
    assert.equal(translate("tr", "member.nicknameUpdated"), "Takma ad güncellendi.");
  });

  it("translates server renaming and current invite targets in both languages", () => {
    assert.equal(translate("en", "server.rename"), "Rename server");
    assert.equal(translate("en", "invite.joinServerTitle", { server: "Onyx Lounge" }), "Join Onyx Lounge");
    assert.equal(translate("tr", "server.rename"), "Sunucu adını değiştir");
    assert.equal(translate("tr", "invite.joinServerTitle", { server: "Onyx Lounge" }), "Onyx Lounge sunucusuna katıl");
  });

  it("translates shared sidebar moderation confirmations in both languages", () => {
    assert.equal(translate("en", "member.disconnectTitle", { nickname: "Ada" }), "Disconnect Ada?");
    assert.equal(translate("en", "member.kickCopy"), "The member can return only with a new invite.");
    assert.equal(translate("tr", "member.banTitle", { nickname: "Ada" }), "Ada sunucudan yasaklansın mı?");
    assert.equal(translate("tr", "member.disconnect"), "Ses bağlantısını kes");
  });

  it("translates owner voice, invite limits, and reconnect states in both languages", () => {
    assert.equal(translate("en", "member.ownerMuted"), "Muted by owner");
    assert.equal(translate("tr", "member.ownerDeafened"), "Owner tarafından sağırlaştırıldı");
    assert.equal(translate("en", "invite.remainingUses", { count: 5 }), "5 uses remaining");
    assert.equal(translate("tr", "invite.expiry30d"), "30 gün");
    assert.equal(translate("en", "connection.retryAttempt", { count: 3 }), "Reconnect attempt 3");
    assert.equal(translate("tr", "connection.browserOffline"), "Tarayıcının internet bağlantısı yok.");
  });

  it("translates voice room move confirmation", () => {
    assert.equal(translate("en", "voice.moveTitle"), "Switch voice rooms?");
    assert.equal(translate("tr", "voice.moveConfirm"), "Kanala geç");
  });

  it("translates blocked audio recovery copy", () => {
    assert.equal(translate("en", "audio.enablePlayback"), "Enable audio");
    assert.equal(translate("tr", "audio.enablePlayback"), "Sesi etkinleştir");
    assert.equal(translate("tr", "audio.playbackBlocked"), "Tarayıcı gelen sesi duraklattı.");
  });

  it("translates general audio levels and microphone testing", () => {
    assert.equal(translate("en", "audio.inputVolume"), "Input level");
    assert.equal(translate("en", "audio.startTest"), "Listen to microphone");
    assert.equal(translate("tr", "audio.outputVolume"), "Genel çıkış seviyesi");
    assert.equal(translate("tr", "audio.stopTest"), "Dinlemeyi durdur");
    assert.equal(translate("tr", "audio.testHint"), "Geri beslemeyi önlemek için kulaklık kullanın.");
  });

  it("keeps the landing invitation concise in both languages", () => {
    assert.equal(translate("en", "landing.title"), "A room for your people");
    assert.equal(translate("tr", "landing.title"), "Kendi grubun için bir oda");
    assert.equal(translate("tr", "landing.inviteCta"), "Davetle katıl");
  });
});
