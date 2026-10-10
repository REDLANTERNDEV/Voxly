import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "node:test";
import { ApplicationUpdateStatus } from "../src/components/ApplicationUpdateStatus.js";
import { ApplicationUpdateContext } from "../src/lib/applicationUpdates.js";
import type { DesktopUpdateSnapshot } from "../src/lib/desktopUpdates.js";
import { translate } from "../src/lib/i18n.js";

function render(
  phase: DesktopUpdateSnapshot["phase"],
  error: string | null,
  surface: "account" | "settings",
  language: "en" | "tr",
  pendingClient: string | null = null
) {
  const value = {
    desktop: { currentVersion: "0.1.0", version: "0.2.0", phase, error },
    reviewDesktop: async () => {},
    pendingClient,
    clientBusy: false,
    reloadClient() {}
  };
  const props = { surface, t: (key: Parameters<typeof translate>[1]) => translate(language, key) };
  return renderToStaticMarkup(
    createElement(ApplicationUpdateContext, { value }, createElement(ApplicationUpdateStatus, props))
  );
}

test("account menus omit desktop update failures while Settings retains recovery", () => {
  for (const language of ["en", "tr"] as const) {
    for (const error of ["update_network", "update_signature", "update_invalid", "update_review_failed"]) {
      assert.equal(render("error", error, "account", language), "");
      assert.match(render("error", error, "settings", language), /<button/);
    }
  }
});

test("account menus still show available desktop updates and pending interface updates", () => {
  for (const language of ["en", "tr"] as const) {
    for (const phase of ["available", "downloading", "ready", "installing"] as const) {
      assert.match(render(phase, null, "account", language), /<button/);
    }
    assert.ok(
      render("error", "update_network", "account", language, "new").includes(translate(language, "clientUpdate.ready"))
    );
    assert.doesNotMatch(
      render("error", "update_network", "account", language, "new"),
      new RegExp(translate(language, "desktopUpdate.error"))
    );
  }
});
