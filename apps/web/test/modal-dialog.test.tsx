import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModalDialog } from "../src/components/ui/Dialogs.js";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("the shared modal shell", () => {
  it("draws every small dialog at the document root, never inside the rail or a drawer", () => {
    // A dialog drawn in place sits inside whatever stacking context opened it:
    // the rail's Join dialog was drawn under the channel sidebar that way.
    for (const path of sources("src")) {
      const source = readFileSync(path, "utf8");
      if (!source.includes('className="confirm-backdrop"')) continue;
      assert.ok(
        /<ModalPortal>|<FloatingPortal>/.test(source),
        `${path} draws a confirm-backdrop without a portal; use ModalDialog`
      );
    }
  });

  it("is a labelled modal that says when it is busy", () => {
    const html = renderToStaticMarkup(
      <ModalDialog as="form" labelledBy="title" busy onDismiss={() => {}}>
        <h2 id="title">Title</h2>
      </ModalDialog>
    );
    assert.match(html, /<form[^>]*class="confirm-dialog"[^>]*role="dialog"/);
    assert.match(html, /aria-modal="true"/);
    assert.match(html, /aria-labelledby="title"/);
    assert.match(html, /aria-busy="true"/);
  });

  it("answers keys only when it is the topmost modal", () => {
    const source = readFileSync("src/components/ui/Dialogs.tsx", "utf8");
    const shell = source.slice(
      source.indexOf("export function ModalDialog"),
      source.indexOf("export function ConfirmDialog")
    );
    assert.match(shell, /modals\[modals\.length - 1\] !== surface\.current/);
    assert.match(shell, /if \(!isBusy\.current\) dismiss\.current\(\)/);
  });
});
