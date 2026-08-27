import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createInitialVoiceControls, toggleVoiceControl } from "../src/lib/voiceControls.js";

/**
 * A member who cannot be heard, or cannot hear, should be able to tell at a
 * glance — and the states worth noticing used to be the two dressed as
 * "everything is fine".
 *
 * `active` on a dock control is whether its toggle is pressed, and pressed means
 * the opposite thing on Deafen from what it means on the microphone: a live
 * microphone and a deafened member were both `is-active`, a muted microphone and
 * a working headset both `is-off`. So the regression these pin is a *polarity*
 * one, not a colour one — no contrast assertion would have caught it.
 */
describe("dock self-silenced state", () => {
  const dock = () => readFileSync("src/components/shell/VoiceDock.tsx", "utf8");
  const primitives = () => readFileSync("src/components/ui/Primitives.tsx", "utf8");
  const styles = () => readFileSync("src/styles.css", "utf8");

  it("marks the microphone silenced exactly when it is off, and the headset when deafened", () => {
    // The two branches that render a member's own controls, which is where the
    // polarity has to be right — the owner-enforced branches beside them speak
    // their own language and are checked separately below.
    const mic = dock().match(/onToggleControl\("mic"\)[\s\S]{0,80}/)?.[0] ?? "";
    const deafen = dock().match(/onToggleControl\("deafen"\)[\s\S]{0,80}/)?.[0] ?? "";

    assert.match(dock(), /silenced=\{!props\.controls\.mic\.on\}/);
    assert.match(dock(), /silenced=\{props\.controls\.deafen\.on\}/);
    assert.match(mic, /MicIcon off=\{!props\.controls\.mic\.on\}/);
    assert.match(deafen, /HeadsetIcon off=\{props\.controls\.deafen\.on\}/);
  });

  it("leaves camera and screen share unmarked, because off is their resting state", () => {
    const camera = dock().match(/onToggleControl\("camera"\)[\s\S]{0,80}/)?.[0] ?? "";
    const screen = dock().match(/onToggleControl\("screenShare"\)[\s\S]{0,80}/)?.[0] ?? "";
    const cameraControl = dock().match(/<ControlButton[^>]*onToggleControl\("camera"\)/)?.[0] ?? "";
    const screenControl = dock().match(/<ControlButton[^>]*onToggleControl\("screenShare"\)/)?.[0] ?? "";

    assert.notEqual(camera, "");
    assert.notEqual(screen, "");
    assert.doesNotMatch(cameraControl, /silenced/);
    assert.doesNotMatch(screenControl, /silenced/);
  });

  it("carries silencing on its own class rather than deriving it from the pressed state", () => {
    assert.match(primitives(), /silenced \? "is-self-off" : ""/);
    // `aria-pressed` keeps saying whether the toggle is pressed. Repointing it
    // at "silenced" would make the Deafen button announce itself unpressed
    // while it is deafening somebody.
    assert.match(primitives(), /aria-pressed=\{active\}/);
  });

  it("wins over the pressed and unpressed styles it has to override", () => {
    // Deafened is `is-active is-self-off` and muted is `is-off is-self-off`, so
    // the rule has to outrank both rather than rely on source order.
    assert.match(styles(), /\.icon-btn\.control-icon\.is-self-off\s*\{/);
  });

  it("is solid where the owner-enforced state is soft, and does not borrow its pulse", () => {
    const selfOff = styles().match(/^\.icon-btn\.control-icon\.is-self-off\s*\{[\s\S]*?^\}/m)?.[0] ?? "";
    const enforced = styles().match(/^\.icon-btn\.is-danger-state\s*\{[\s\S]*?^\}/m)?.[0] ?? "";

    assert.match(selfOff, /background:\s*var\(--danger\)/);
    assert.match(enforced, /background:\s*var\(--danger-soft\)/);
    // The nagging loop belongs to the state a member cannot undo. Theirs says
    // itself once, on the way in.
    assert.match(enforced, /animation:\s*muted-control-ring[^;]*infinite/);
    assert.doesNotMatch(styles(), /self-silenced-in[^;]*infinite/);
  });

  it("agrees with the sentence the dock writes beside it", () => {
    // One rule behind both signals: a colour on a button cannot say *which* of
    // the two silences it is, and the sentence is what does.
    assert.match(dock(), /voiceDockSilenced\(props\.controls\)/);
    assert.match(dock(), /dock-status-silenced/);
    assert.match(styles(), /\.dock-status-silenced\s*\{/);
  });

  it("reports silence for a muted microphone, a deafened member, and neither otherwise", async () => {
    const { voiceDockSilenced } = await import("../src/app/presentation.js");
    const live = createInitialVoiceControls();

    assert.equal(voiceDockSilenced(live), false);
    assert.equal(voiceDockSilenced(toggleVoiceControl(live, "mic")), true);
    // Deafening takes the microphone with it, so this is silent both ways.
    assert.equal(voiceDockSilenced(toggleVoiceControl(live, "deafen")), true);
    // A camera changes neither question.
    assert.equal(voiceDockSilenced(toggleVoiceControl(live, "camera")), false);
  });
});
