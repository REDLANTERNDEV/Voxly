import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { translate, type LanguageCode, type TranslationKey } from "../src/lib/i18n.js";
import { parsePathRoute } from "../src/lib/navigation.js";
import { startupSurface } from "../src/lib/startupSurface.js";

const translator = (language: LanguageCode) =>
  (key: TranslationKey, values?: Record<string, string | number>) => translate(language, key, values);

/**
 * The arriving Device has no session, which is the entire point — so the route
 * it lands on has to survive every gate that exists to send a sessionless
 * caller somewhere else. These pin that, and the approval step it depends on.
 */
describe("linking a device", () => {
  const dialog = () => readFileSync("src/features/auth/LinkDeviceDialog.tsx", "utf8");
  const screen = () => readFileSync("src/features/auth/LinkDeviceScreen.tsx", "utf8");
  const routes = () => readFileSync("src/app/AppRoutes.tsx", "utf8");

  it("routes /link without a session", () => {
    // The clearer name, and the short one it replaced — an address that used
    // to work should keep working.
    assert.deepEqual(parsePathRoute("/link-device"), { name: "link-device" });
    assert.deepEqual(parsePathRoute("/link"), { name: "link-device" });
  });

  it("does not hold the arriving Device behind the shell skeleton", () => {
    // Every other signed-out entry point renders immediately; this one has to
    // as well, or a member typing a 90-second code watches a spinner instead.
    for (const state of ["loading", "ready", "error"] as const) {
      assert.notEqual(startupSurface("link-device", state), "shell-skeleton");
    }
  });

  it("renders the link screen before the signed-out invite fallback", () => {
    // AppRoutes sends every sessionless route to the invite screen. The link
    // route must be answered above that line or it never renders at all.
    const source = routes();
    const linkAt = source.indexOf('route.name === "link-device"');
    const inviteFallbackAt = source.indexOf("if (!user || route.name === \"invite\")");

    assert.ok(linkAt > 0, "the link route is not rendered");
    assert.ok(linkAt < inviteFallbackAt, "the invite fallback would swallow the link route");
  });

  it("never signs the arriving Device in on its own", () => {
    // A claim is asking, not arriving. Only a poll that comes back approved
    // carries a session, and that only happens after a person approves.
    assert.doesNotMatch(screen(), /claimDeviceLink[\s\S]{0,200}onLinked\(\)/);
    assert.match(screen(), /status === "approved"[\s\S]{0,40}onLinked\(\)/);
  });

  it("shows what is asking, not just a number to accept", () => {
    // Approving whatever turns up would give back the property the approval
    // step exists to buy.
    assert.match(dialog(), /link\.approveCopy[\s\S]{0,40}device: waiting\.label/);
    assert.match(dialog(), /waiting\.confirmation/);
  });

  it("retires the code it minted, by id, rather than whatever is outstanding", () => {
    // React's development double-mount runs setup, cleanup, setup. A cleanup
    // that retired "everything outstanding" would kill the code the second
    // setup had just minted, and the member would be told a perfectly good
    // code had expired. This was a real bug, reported from a real attempt.
    assert.match(dialog(), /cancelDeviceLink\(minted\)/);
    assert.doesNotMatch(dialog(), /cancelDeviceLink\(\)/);
  });

  it("does not mint again when the translator changes identity", () => {
    // `t` in the dependency array would mint a second code and retire the one
    // already on screen. The effect depends on the guide and nothing else.
    assert.match(dialog(), /void createDeviceLink\(\)[\s\S]{0,1200}\}, \[guiding, generation\]\);/);
  });

  it("does not start the ninety seconds until the code is on screen", () => {
    // Burning the window behind an explanation the member is still reading
    // hands them a code that is already half spent.
    assert.match(dialog(), /if \(guiding\) return;[\s\S]{0,120}createDeviceLink\(\)/);
  });

  it("reloads into the app rather than navigating in place", () => {
    // The session cookie is set by the request that just succeeded, but this
    // app already asked `/api/me` at startup and was told nobody was signed
    // in. A client-side navigation lands on the signed-out landing page and the
    // member has to refresh by hand — which is exactly what happened on a real
    // attempt. Reloading is what makes "I linked my phone and it just worked".
    const source = routes();

    assert.match(source, /onLinked=\{\(\) => window\.location\.assign\(resolveInitialRoute/);
    assert.doesNotMatch(source, /onLinked=\{\(\) => navigate/);
  });

  it("sends a recovered Device into the app too, not to the landing page", () => {
    assert.match(routes(), /onRecovered=\{\(\) => window\.location\.assign\(resolveInitialRoute/);
  });

  it("tells the member where to go on the other device", () => {
    // The instruction lives on the *other* Device, which is the one place this
    // interface cannot reach — so it has to say the address out loud. Read from
    // the running page, because a configured public URL would be wrong for
    // anybody on a local network, which is when this matters most.
    const guide = readFileSync("src/lib/linkGuide.ts", "utf8");

    assert.match(dialog(), /linkAddress\(\)/);
    assert.match(guide, /window\.location\.origin/);
    for (const language of ["en", "tr"] as const) {
      for (const step of ["link.step1", "link.step2", "link.step3"] as const) {
        assert.ok(translator(language)(step).length > 0, `${step} missing in ${language}`);
      }
    }
  });

  it("can be reopened after the member says not to show it again", () => {
    // "Do not show this again" is not "never let me see this again". A member
    // who dismissed the guide months ago and is now helping somebody else has
    // to be able to get it back.
    assert.match(dialog(), /writeLinkGuideDismissed\(true\)/);
    assert.match(dialog(), /setGuiding\(true\)/);
    assert.match(dialog(), /link\.howItWorks/);
  });

  it("offers the QR and the typed code together, never one instead of the other", () => {
    // A camera that will not focus, a cracked lens, or a member who simply
    // prefers typing all have to keep working.
    assert.match(dialog(), /<LinkQr code=\{code\}/);
    assert.match(dialog(), /className="link-code code-face"/);
  });

  it("captures a scanned code before anything can strip it from the address", () => {
    // React's development double-mount runs the first mount, whose effect
    // removes the fragment from history, then mounts again — by which point the
    // address bar no longer has it. Reading at import time happens first, and
    // "the code this page was opened with" is a fact about the page load rather
    // than about a render. This was a real bug: the input came up empty.
    const guide = readFileSync("src/lib/linkGuide.ts", "utf8");
    const screen = readFileSync("src/features/auth/LinkDeviceScreen.tsx", "utf8");

    assert.match(guide, /const scannedOnLoad = typeof window === "undefined"/);
    assert.match(screen, /scannedLinkCode\(\)/);
    assert.doesNotMatch(screen, /readScannedLinkCode\(\)/);
  });

  it("takes a scanned code out of the phone's history", () => {
    // A fragment never reaches the server, but it does sit in history, and
    // there is no reason for it to stay there.
    assert.match(
      readFileSync("src/features/auth/LinkDeviceScreen.tsx", "utf8"),
      /history\.replaceState\(null, "", window\.location\.pathname\)/
    );
  });

  it("says the same thing about a bad code in both languages", () => {
    // One answer for unknown, expired and already-used, matching the server.
    for (const language of ["en", "tr"] as const) {
      assert.ok(translator(language)("link.codeInvalid").length > 0);
      assert.ok(translator(language)("link.confirmationHint").length > 0);
    }
  });

  it("tells the approver to compare the number rather than just trust it", () => {
    assert.match(translate("en", "link.confirmationHint"), /same number/);
    assert.match(translate("tr", "link.confirmationHint"), /aynı numarayı/);
  });
});
