import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { translate, type LanguageCode } from "../src/lib/i18n.js";
import { parsePathRoute } from "../src/lib/navigation.js";

/**
 * A member now holds a code worth ninety seconds and a code worth their account.
 *
 * If those two look alike, the second gets treated like the first, and the
 * whole design of the Recovery code is wasted. These pin the ways they are kept
 * apart — and the one that matters most, that the expensive path always says
 * what it costs *before* it is taken.
 */
describe("the two secrets", () => {
  const linkDialog = () => readFileSync("src/features/auth/LinkDeviceDialog.tsx", "utf8");
  const recoveryReveal = () => readFileSync("src/features/auth/RecoveryCode.tsx", "utf8");
  const recoverScreen = () => readFileSync("src/features/auth/RecoverScreen.tsx", "utf8");
  const styles = () => readFileSync("src/styles.css", "utf8");

  it("shows and receives a code in the same face", () => {
    // They had drifted: the same characters read clearly in the settings dialog
    // and ambiguously in the entry field — the worst possible split, because a
    // member checks one against the other. The alphabet has no O, I, L or U at
    // all, so an ambiguous glyph can only be the digit; a slashed zero says so
    // rather than leaving the member to know it.
    const styles = readFileSync("src/styles.css", "utf8");
    assert.match(styles, /\.code-face \{[\s\S]{0,300}slashed-zero/);

    for (const [path, count] of [
      ["src/features/auth/LinkDeviceDialog.tsx", 2],
      ["src/features/auth/LinkDeviceScreen.tsx", 2],
      ["src/features/auth/RecoverScreen.tsx", 1],
      ["src/features/auth/RecoveryCode.tsx", 1]
    ] as const) {
      const source = readFileSync(path, "utf8");
      assert.equal(source.split("code-face").length - 1, count, `${path} code surfaces`);
    }
  });

  it("does not dress them the same", () => {
    // Different class, different size, different shape. The Link code is a
    // headline to read across a room; the Recovery code is a block to copy.
    assert.match(linkDialog(), /className="link-code code-face"/);
    assert.match(recoveryReveal(), /className="recovery-code code-face"/);
    assert.match(styles(), /\.link-code,\n\.link-confirmation \{[\s\S]{0,200}font-size: 28px/);
    assert.match(styles(), /\.recovery-code \{[\s\S]{0,240}font-size: 15px/);
  });

  it("uses a different verb for each", () => {
    // CONTEXT.md: they are *Link* and *Recovery*, and neither is called pairing,
    // a password, or a backup code.
    for (const language of ["en", "tr"] as const) {
      const link = translate(language, "link.title");
      const recovery = translate(language, "recovery.title");
      assert.notEqual(link, recovery);
      for (const forbidden of [/pair/i, /password/i, /şifre/i, /parola/i, /backup/i, /yedek/i]) {
        assert.doesNotMatch(link, forbidden, `link.title in ${language}`);
        assert.doesNotMatch(recovery, forbidden, `recovery.title in ${language}`);
      }
    }
  });

  it("states what recovery costs before the code is entered, not after", () => {
    // A member who reached for this when they meant to link a Device is about
    // to sign themselves out of everything. Finding that out afterwards is not
    // a warning, it is a surprise.
    const source = recoverScreen();
    const costAt = source.indexOf('t("recovery.cost")');
    const inputAt = source.indexOf('name="recoveryCode"');

    assert.ok(costAt > 0 && inputAt > 0);
    assert.ok(costAt < inputAt, "the cost is stated below the field a member has already filled in");
  });

  it("says, in both languages, that recovery signs every other device out", () => {
    assert.match(translate("en", "recovery.cost"), /every other device/i);
    assert.match(translate("tr", "recovery.cost"), /bütün cihazlarındaki/i);
  });

  it("will not let a member walk past the recovery code", () => {
    // It is shown once and nothing can read it back, so the confirm is not
    // ceremony — it is the difference between having a way back and finding out
    // you do not on the day your laptop dies.
    assert.match(recoveryReveal(), /disabled=\{!saved\}/);
  });

  it("offers both ways back to somebody holding no device at all", () => {
    // The case neither the app shell nor the invite screen can serve.
    assert.deepEqual(parsePathRoute("/link-device"), { name: "link-device" });
    assert.deepEqual(parsePathRoute("/recover"), { name: "recover" });
    const landing = readFileSync("src/features/auth/AuthScreens.tsx", "utf8");
    assert.match(landing, /href="\/link-device"/);
    assert.match(landing, /href="\/recover"/);
  });

  it("puts the cheap path before the expensive one", () => {
    // Linking costs nothing and recovery signs every other Device out, so a
    // member has to meet linking first.
    const landing = readFileSync("src/features/auth/AuthScreens.tsx", "utf8");

    assert.ok(landing.indexOf('href="/link-device"') < landing.indexOf('href="/recover"'));
  });

  it("says how a device arrived, so 'was that me?' has an answer", () => {
    const list = readFileSync("src/components/DeviceSettings.tsx", "utf8");

    assert.match(list, /devices\.arrivedByRecovery/);
    assert.match(list, /devices\.arrivedByLink/);
    for (const language of ["en", "tr"] as const satisfies readonly LanguageCode[]) {
      assert.notEqual(
        translate(language, "devices.arrivedByLink"),
        translate(language, "devices.arrivedByRecovery")
      );
    }
  });
});
