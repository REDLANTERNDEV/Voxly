import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { voiceStatusItems } from "../src/app/presentation.js";
import type { Translate } from "../src/app/types.js";

const t = ((key: string) => key) as Translate;
const selfDeafened = { mic: false, camera: false, screen: false, deafened: true, speaking: false };

describe("voice status presentation", () => {
  it("lets owner deafen replace derived self mute and deafen badges", () => {
    const items = voiceStatusItems(selfDeafened, { muted: false, deafened: true }, t);

    assert.deepEqual(items.map((item) => item.label), ["member.ownerDeafened"]);
  });

  it("shows only the two enforced badges when owner mute and deafen are combined", () => {
    const items = voiceStatusItems(selfDeafened, { muted: true, deafened: true }, t);

    assert.deepEqual(items.map((item) => item.label), ["member.ownerDeafened", "member.ownerMuted"]);
  });

  it("retains a distinct self deafen badge beside owner mute", () => {
    const items = voiceStatusItems(selfDeafened, { muted: true, deafened: false }, t);

    assert.deepEqual(items.map((item) => item.label), ["member.ownerMuted", "common.deafened"]);
  });
});
