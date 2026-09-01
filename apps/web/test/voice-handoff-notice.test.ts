import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { VoiceForceLeaveReason } from "@voxly/shared";
import { forceLeaveNoticeKey } from "../src/app/presentation.js";
import { translate } from "../src/lib/i18n.js";

/**
 * Voice ending without the member ending it used to be a silent teardown, which
 * left them unable to tell a call that *moved* from a call that *broke*. These
 * pin that every reason says something, and that the one which is not a failure
 * is not dressed as one.
 */
describe("why voice ended", () => {
  const reasons: VoiceForceLeaveReason[] = [
    "joined_another_device",
    "joined_another_room",
    "owner_disconnect",
    "server_access_revoked",
    "room_deleted",
    "server_deleted"
  ];

  it("says something for every reason, in both languages", () => {
    for (const reason of reasons) {
      for (const language of ["en", "tr"] as const) {
        const message = translate(language, forceLeaveNoticeKey(reason));
        assert.ok(message.length > 0, `${reason} says nothing in ${language}`);
        assert.doesNotMatch(message, /^voiceNotice\./, `${reason} fell through to its key in ${language}`);
      }
    }
  });

  it("names the other device when the call simply moved", () => {
    assert.match(translate("en", forceLeaveNoticeKey("joined_another_device")), /other device/);
    assert.match(translate("tr", forceLeaveNoticeKey("joined_another_device")), /diğer cihazına/);
  });

  it("does not report a working handoff as a fault", () => {
    // It is rendered as a neutral toast with role="status", not the danger
    // toast with role="alert" that failures use.
    const chrome = readFileSync("src/components/shell/AppChrome.tsx", "utf8");
    const primitives = readFileSync("src/components/ui/Primitives.tsx", "utf8");

    assert.match(chrome, /voiceNotice\} tone="neutral"/);
    assert.match(primitives, /tone === "danger" \? "alert" : "status"/);
  });

  it("tells the member before it forgets, not instead of tearing down", () => {
    // The teardown still has to happen — releasing the microphone and the peer
    // connections is the point. The notice is in addition to it.
    const sync = readFileSync("src/app/useRealtimeSync.ts", "utf8");

    assert.match(sync, /leaveVoiceRef\.current\(\);[\s\S]{0,300}forceLeaveNoticeRef\.current\(reason\)/);
  });
});
