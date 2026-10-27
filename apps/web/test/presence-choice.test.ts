import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isPresenceChoiceRequest, type PresenceChoiceState } from "@voxly/shared";
import { AccountStatusMenu } from "../src/components/shell/AccountStatusMenu.js";
import { translate, type TranslationKey } from "../src/lib/i18n.js";
import {
  presenceChoiceRequest,
  presenceChoiceSilencesMessages,
  presenceChoices,
  presenceDurationKey,
  presenceDurations,
  selfPresenceState
} from "../src/lib/presenceChoice.js";

describe("picked Status", () => {
  it("offers Discord's durations, ending with Forever", () => {
    assert.deepEqual(presenceDurations, [15, 60, 480, 1440, 4320, null]);
    assert.deepEqual(presenceChoices, ["online", "idle", "dnd", "invisible"]);
  });

  it("builds requests the server accepts", () => {
    for (const status of presenceChoices) {
      for (const minutes of presenceDurations) {
        assert.equal(isPresenceChoiceRequest(presenceChoiceRequest(status, minutes)), true);
      }
    }
    assert.deepEqual(presenceChoiceRequest("online", 60), { status: "online" });
    assert.deepEqual(presenceChoiceRequest("dnd", null), { status: "dnd", duration: { mode: "indefinite" } });
    assert.deepEqual(presenceChoiceRequest("idle", 480), {
      status: "idle",
      duration: { mode: "timed", durationMinutes: 480 }
    });
  });

  it("draws your own dot from what you picked, and from what was measured only when you picked Online", () => {
    assert.equal(selfPresenceState("online", "online"), "online");
    assert.equal(selfPresenceState("online", "idle"), "idle");
    assert.equal(selfPresenceState("online", undefined), "online");
    assert.equal(selfPresenceState("dnd", "idle"), "dnd");
    assert.equal(selfPresenceState("invisible", "online"), "invisible");
    assert.equal(selfPresenceState("idle", "online"), "idle");
  });

  it("silences messages only for Do Not Disturb", () => {
    assert.deepEqual(
      presenceChoices.filter((choice) => presenceChoiceSilencesMessages(choice)),
      ["dnd"]
    );
  });

  it("names every Status and duration in both languages", () => {
    const keys: TranslationKey[] = [
      ...presenceChoices.map((choice) => `presence.${choice}` as const),
      ...presenceDurations.map((minutes) => presenceDurationKey(minutes)),
      "presence.statusMenu",
      "presence.dndDescription",
      "presence.invisibleDescription"
    ];
    for (const key of keys) {
      assert.ok(translate("en", key).length > 0, key);
      assert.ok(translate("tr", key).length > 0, key);
      assert.notEqual(translate("en", key), translate("tr", key), key);
    }
    assert.equal(translate("en", "presence.until", { time: "Fri 14:00" }), "Until Fri 14:00");
    assert.match(translate("tr", "presence.until", { time: "Cum 14:00" }), /Cum 14:00/);
  });
});

describe("account Status menu", () => {
  const render = (choice: PresenceChoiceState) =>
    renderToStaticMarkup(
      createElement(AccountStatusMenu, {
        choice,
        selfState: selfPresenceState(choice.status, "online"),
        language: "en",
        timeFormat: "24",
        t: (key: TranslationKey, values?: Record<string, string | number>) => translate("en", key, values),
        onChange: () => undefined,
        onDone: () => undefined
      })
    );

  it("offers Online directly and the other three through a duration submenu", () => {
    const markup = render({ status: "online", until: null });

    assert.match(markup, /role="group" aria-label="Set your status"/);
    assert.match(markup, /aria-pressed="true"[^>]*>[\s\S]*?Online/);
    assert.equal(markup.match(/menu-submenu-trigger/g)?.length, 3);
    assert.match(markup, /You won&#x27;t get message sounds or alerts/);
    assert.match(markup, /You&#x27;ll appear offline/);
    // A description is read with the row, not as a separate stop.
    assert.equal(markup.match(/aria-describedby=/g)?.length, 2);
  });

  it("shows the current Status and when it ends", () => {
    const markup = render({ status: "dnd", until: "2026-10-30T14:00:00.000Z" });

    assert.match(markup, /Status: Do Not Disturb/);
    assert.match(markup, /Until /);
    assert.match(markup, /account-status-option is-current/);
    assert.match(markup, /presence-dot is-dnd/);
  });
});
