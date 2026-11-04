import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JoinServerDialog } from "../src/features/invites/JoinServerDialog.js";
import { translate } from "../src/lib/i18n.js";

const noop = () => {};

describe("the rail's join dialog (ADR-0036)", () => {
  it("is a labelled modal with one field, in both languages", () => {
    for (const language of ["en", "tr"] as const) {
      const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
        translate(language, key, values);
      const html = renderToStaticMarkup(
        <JoinServerDialog returnFocus={null} t={t} onCancel={noop} onOpenInvite={noop} />
      );
      assert.match(html, /role="dialog"/);
      assert.match(html, /aria-modal="true"/);
      assert.match(html, /aria-labelledby="joinServerTitle"/);
      assert.ok(html.includes(t("server.joinTitle")));
      assert.equal((html.match(/<input/g) ?? []).length, 1);
    }
  });

  it("decides with the shared parser and opens this Installation's invite on the card", () => {
    const dialog = readFileSync("src/features/invites/JoinServerDialog.tsx", "utf8");
    assert.match(dialog, /parseInviteInput\(value,\s*installationOrigins\(\)\)/);
    assert.match(dialog, /onOpenInvite\(parsed\.token\)/);
    assert.match(dialog, /event\.key === "Escape"/);
    // Another Installation's invite is handed off, never accepted here.
    assert.doesNotMatch(dialog, /acceptInvite/);
  });

  it("puts a join-only + after the last server, for every member", () => {
    const rail = readFileSync("src/components/shell/WorkspaceRail.tsx", "utf8");
    const servers = rail.indexOf("servers.map(");
    const plus = rail.indexOf('className="workspace-rail-link server-avatar workspace-join"');
    assert.ok(servers >= 0 && plus > servers);
    assert.match(rail, /aria-label=\{t\("server\.joinOpen"\)\}/);
    assert.doesNotMatch(rail.slice(plus - 400, plus), /canInvite|role === "owner"/);
  });
});
