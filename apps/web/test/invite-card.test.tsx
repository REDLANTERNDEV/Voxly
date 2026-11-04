import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InviteScreen, InviteServerSummary } from "../src/features/auth/InviteScreen.js";
import { nextInviteJoinStep, serverMark } from "../src/lib/inviteJoin.js";
import { translate } from "../src/lib/i18n.js";
import { parsePathRoute } from "../src/lib/navigation.js";

const noop = () => {};
const token = "a-valid-looking-invite-token-0123456789";

function withWindow<T>(run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search: "", origin: "http://fixture", hash: "", pathname: "/invite" } }
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

describe("invite card (ADR-0036)", () => {
  it("asks a visitor with no session whether they are new before anything is created", () => {
    assert.equal(nextInviteJoinStep("card", { kind: "join", signedIn: false }), "choose");
    assert.equal(nextInviteJoinStep("choose", { kind: "new" }), "new");
    assert.equal(nextInviteJoinStep("choose", { kind: "existing" }), "link");
    assert.equal(nextInviteJoinStep("link", { kind: "lostDevice" }), "recover");
  });

  it("joins at once for a signed-in visitor", () => {
    assert.equal(nextInviteJoinStep("card", { kind: "join", signedIn: true }), "accept");
  });

  it("walks back one step at a time and ignores events that do not apply", () => {
    assert.equal(nextInviteJoinStep("recover", { kind: "back" }), "link");
    assert.equal(nextInviteJoinStep("link", { kind: "back" }), "choose");
    assert.equal(nextInviteJoinStep("new", { kind: "back" }), "choose");
    assert.equal(nextInviteJoinStep("choose", { kind: "back" }), "card");
    assert.equal(nextInviteJoinStep("card", { kind: "lostDevice" }), "card");
    assert.equal(nextInviteJoinStep("new", { kind: "existing" }), "new");
  });

  it("draws a Server by the first character of its name, emoji included", () => {
    assert.equal(serverMark("  the basement"), "T");
    assert.equal(serverMark("🎮 Gamers"), "🎮");
    assert.equal(serverMark(""), "V");
  });

  it("shows no token field once a link brought the visitor here, in both languages", () => {
    withWindow(() => {
      for (const language of ["en", "tr"] as const) {
        const html = renderToStaticMarkup(
          <InviteScreen
            initialToken={token}
            existingUser={false}
            currentUser={null}
            turnstileSiteKey={null}
            onAccepted={noop}
            language={language}
            timeFormat="auto"
            t={(key, values) => translate(language, key, values)}
            onLanguageChange={noop}
          />
        );
        assert.doesNotMatch(html, /name="inviteLink"/);
        assert.doesNotMatch(html, /name="nickname"/);
        assert.match(html, /class="invite-server"/);
      }
    });
  });

  it("keeps one paste field when no link was opened", () => {
    withWindow(() => {
      const html = renderToStaticMarkup(
        <InviteScreen
          initialToken=""
          existingUser
          currentUser={null}
          turnstileSiteKey={null}
          onAccepted={noop}
          language="en"
          timeFormat="auto"
          t={(key, values) => translate("en", key, values)}
          onLanguageChange={noop}
        />
      );
      assert.equal((html.match(/name="inviteLink"/g) ?? []).length, 1);
    });
  });

  it("says who is there, counting one member in the singular", () => {
    for (const language of ["en", "tr"] as const) {
      const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
        translate(language, key, values);
      const html = renderToStaticMarkup(
        <InviteServerSummary
          preview={{ serverName: "The Basement", expiresAt: null, remainingUses: null, memberCount: 1, onlineCount: 1 }}
          language={language}
          timeFormat="auto"
          t={t}
        />
      );
      assert.match(html, />T</);
      assert.ok(html.includes(t("invite.oneMember")));
      assert.ok(html.includes(t("invite.onlineCount", { count: 1 })));
    }
  });

  it("shares one accept request per token and accepts as the linked Account afterwards", () => {
    const api = readFileSync("src/api.ts", "utf8");
    const screen = readFileSync("src/features/auth/InviteScreen.tsx", "utf8");
    assert.match(api, /inviteAcceptRequests\.get\(key\)/);
    assert.match(api, /\.finally\(\(\)\s*=>\s*inviteAcceptRequests\.delete\(key\)\)/);
    // After Link or Recovery the page reloads into the Server rather than
    // navigating: startup resolved it as signed out.
    assert.match(screen, /onLinked=\{joinAsSignedIn\}/);
    assert.match(screen, /onRecovered=\{joinAsSignedIn\}/);
    assert.match(screen, /window\.location\.assign/);
  });

  it("opens a browser's hand-off inside the app by its public id, never a token", () => {
    assert.deepEqual(parsePathRoute("/invite", "#launch=6576e4b7-9209-47f9-9d0b-4f5ad3f6e284"), {
      name: "invite",
      token: "",
      launchId: "6576e4b7-9209-47f9-9d0b-4f5ad3f6e284"
    });
    // Anything else after `launch=` is not an id, so it is read as an ordinary token.
    assert.equal(parsePathRoute("/invite", "#launch=../../x").name, "invite");
    assert.equal((parsePathRoute("/invite", "#launch=../../x") as { launchId?: string }).launchId, undefined);
  });

  it("offers the desktop app only to someone who says they have an Account, and learns from the server whether it opened", () => {
    const screen = readFileSync("src/features/auth/InviteScreen.tsx", "utf8");
    const routes = readFileSync("src/app/AppRoutes.tsx", "utf8");
    // Prepared before the press, because a browser opens another app only from the press itself.
    assert.match(screen, /createInviteLaunch\(inviteToken\)/);
    assert.match(screen, /desktopOpenLink\(window\.location\.origin,\s*false,\s*handoffId\)/);
    assert.match(screen, /fetchInviteLaunch\(handoffId\)/);
    assert.match(screen, /\/Windows\/\.test\(navigator\.userAgent\)/);
    // Most members use a browser and have no app: Join itself never tries one.
    assert.doesNotMatch(screen, /event\.kind === "join" && !event\.signedIn && handoffId/);
    assert.match(screen, /offersApp && step !== "link"|!offersApp \|\| step !== "link"/);
    // Inside the app, a launch id is asked about before it is treated as a sign-in.
    assert.match(routes, /fetchInviteLaunch\(id\)\.then\(\s*\(\)\s*=>\s*navigate\(`\/invite#launch=\$\{id\}`\)/);
  });
});
