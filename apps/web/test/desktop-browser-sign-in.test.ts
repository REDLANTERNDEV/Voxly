import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { translate } from "../src/lib/i18n.js";

const signIn = readFileSync("src/features/auth/DesktopBrowserSignIn.tsx", "utf8");
const api = readFileSync("src/api.ts", "utf8");
const routes = readFileSync("src/app/AppRoutes.tsx", "utf8");

/**
 * A desktop sign-in request starts from a launch in the member's own signed-in
 * browser, never from the desktop window alone (ADR-0027). A request nobody's
 * browser started could be a stranger's, and any member who approved it would
 * hand the stranger their account.
 */
describe("desktop sign-in starts in the member's browser", () => {
  it("never asks the server for a request without a launch", () => {
    assert.match(api, /export async function createDesktopAuthorization\(launchId: string\)/);
    assert.doesNotMatch(signIn, /createDesktopAuthorization\(\s*\)/);
    assert.doesNotMatch(signIn, /void start\(\)/);
  });

  it("sends the member to their browser to start one", () => {
    assert.match(signIn, /href=\{`\$\{window\.location\.origin\}\/desktop\/sign-in`\}/);
    assert.match(routes, /route\.name === "desktop-start"[\s\S]*?<OpenInDesktop t=\{t\} authenticated \/>/);
  });

  it("explains the browser step in both languages", () => {
    for (const key of [
      "desktopSignIn.startTitle",
      "desktopSignIn.startCopy",
      "desktopSignIn.startSignedOut"
    ] as const) {
      assert.notEqual(translate("en", key), translate("tr", key));
    }
  });
});
