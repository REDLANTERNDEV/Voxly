import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { translate } from "../src/i18n.js";
import { presentShortcutRequest, shortcutRequestText, type ShortcutRequest } from "../src/shortcutRequest.js";

const request: ShortcutRequest = {
  id: 4,
  action: "mute",
  binding: "Control+Shift+KeyM",
  origin: "https://chat.example.com"
};

test("a remote shortcut request names the action, keys and Installation in both languages", () => {
  const english = shortcutRequestText(request, (key) => translate("en", key));
  assert.match(
    english,
    /^https:\/\/chat\.example\.com asks to set “Mute \/ unmute microphone” to Ctrl \+ Shift \+ M\./
  );
  const turkish = shortcutRequestText(request, (key) => translate("tr", key));
  assert.match(turkish, /Ctrl \+ Shift \+ M/);
  assert.notEqual(english, turkish);
  assert.match(
    shortcutRequestText({ ...request, binding: null }, (key) => translate("en", key)),
    /asks to remove the “Mute \/ unmute microphone” shortcut/
  );
});

test("only the member's Confirm accepts a remote shortcut request", async () => {
  for (const confirmed of [true, false]) {
    const answers: unknown[] = [];
    await presentShortcutRequest(
      request,
      async () => confirmed,
      async (id, accept) => answers.push([id, accept]),
      (key) => translate("en", key)
    );
    assert.deepEqual(answers, [[4, confirmed]]);
  }
});

test("the Home dialog shows request text as text and only the shell may answer", () => {
  const main = readFileSync("src/main.ts", "utf8");
  const dialog = main.slice(
    main.indexOf("function confirmShortcutRequest"),
    main.indexOf("// Reached only for a saved")
  );
  assert.match(dialog, /element\("shortcut-request-body"\)\.textContent = text;/);
  assert.doesNotMatch(dialog, /innerHTML|insertAdjacentHTML/);
  assert.match(dialog, /resolve\(dialog\.returnValue === "confirm"\)/);
  const html = readFileSync("index.html", "utf8");
  assert.match(html, /id="shortcut-request-dialog"[\s\S]*?<button\s+value="cancel"\s+autofocus/);
  const shell = JSON.parse(readFileSync("src-tauri/capabilities/shell.json", "utf8"));
  assert.ok(shell.permissions.includes("allow-answer-shortcut-request"));
  // The remote Installation's capability must never be able to answer itself.
  assert.doesNotMatch(readFileSync("src-tauri/src/platform.rs", "utf8"), /answer-shortcut-request/);
  const settings = readFileSync("src-tauri/src/shell/settings.rs", "utf8");
  assert.match(settings, /return request_remote_shortcut\(&app, &shell, &action, binding\)\.await;/);
});
