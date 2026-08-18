import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { translate } from "../src/lib/i18n.js";

const voiceMedia = readFileSync("src/lib/useVoiceMedia.ts", "utf8");
const dock = readFileSync("src/components/shell/VoiceDock.tsx", "utf8");
const workspace = readFileSync("src/app/useWorkspaceController.ts", "utf8");

describe("AFK microphone lock", () => {
  it("holds the local track closed, not just the server's record", () => {
    // Audio flows peer to peer, so a server that records `mic: false` stops the
    // indicator and nothing else. The member would still be heard.
    assert.match(voiceMedia, /const micLockedByRoom = \(\) => Boolean\(roomRef\.current && afkRoomIdsRef\.current\.includes\(roomRef\.current\)\)/);
    assert.match(voiceMedia, /moderationRef\.current\.muted \|\| micLockedByRoom\(\)\) return;/);
  });

  it("overrides the join default, since the idle mover passes no options", () => {
    assert.match(
      voiceMedia,
      /const microphoneEnabled = afkRoomIdsRef\.current\.includes\(roomId\)\s*\n\s*\? false\s*\n\s*: options\.microphoneEnabled \?\? true;/
    );
  });

  it("tracks AFK rooms reactively, because the media layer must re-render on them", () => {
    assert.match(workspace, /const \[afkRoomIds, setAfkRoomIds\] = useState<string\[\]>\(\[\]\)/);
    assert.match(voiceMedia, /afkRoomIdsRef\.current = afkRoomIds;/);
  });

  it("shows the control locked rather than leaving it looking broken", () => {
    assert.match(dock, /props\.micLockedByRoom\s*\n\s*\? <ControlButton label=\{props\.t\("room\.afkMuted"\)\} active tone="danger" enabled=\{false\}/);
  });

  it("takes precedence over the owner-mute badge, which it subsumes", () => {
    const lockIndex = dock.indexOf("props.micLockedByRoom");
    const ownerIndex = dock.indexOf("props.voiceModeration.muted");
    assert.ok(lockIndex >= 0 && ownerIndex >= 0);
    assert.ok(lockIndex < ownerIndex, "the room lock is checked first");
  });

  it("names the state in both languages", () => {
    assert.equal(translate("en", "room.afkMuted"), "Muted in the AFK channel");
    assert.equal(translate("tr", "room.afkMuted"), "AFK kanalında susturuldu");
  });
});
