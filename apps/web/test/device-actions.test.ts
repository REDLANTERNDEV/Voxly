import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { formatRecoveryCodeInput, isCompleteRecoveryCode } from "../src/lib/linkCodeInput.js";
import { translate } from "../src/lib/i18n.js";

/**
 * The small things a member does to their own account, and the two places a
 * code is handled. Each of these is here because it was reported from real use
 * rather than imagined.
 */
describe("a member acting on their own account", () => {
  const rail = () => readFileSync("src/components/shell/ChannelRail.tsx", "utf8");
  const menus = () => readFileSync("src/components/shell/SidebarMenus.tsx", "utf8");
  const devices = () => readFileSync("src/components/DeviceSettings.tsx", "utf8");

  it("lets a member rename themselves without asking the owner", () => {
    // What a member is called is theirs. Needing to ask is the kind of small
    // indignity that makes a private group feel like somebody else's property.
    assert.match(rail(), /const canRename = !isRemote/);
  });

  it("puts the two self-silences where a member right-clicks themselves", () => {
    // The dock already has them as buttons; this is the same two switches in
    // the second place anybody looks for "mute me".
    assert.match(menus(), /selfControls\.onToggle\("mic"\)/);
    assert.match(menus(), /selfControls\.onToggle\("deafen"\)/);
    // Checkboxes, not buttons: they report a state rather than fire an action.
    assert.match(menus(), /role="menuitemcheckbox"/);
  });

  it("offers them only on your own row, and only in a call", () => {
    assert.match(rail(), /selfControls=\{!isRemote && props\.activeVoiceRoomId/);
  });

  it("dresses signing a device out as the destructive thing it is", () => {
    assert.match(devices(), /className="btn btn-danger device-sign-out"/);
    assert.match(devices(), /<LeaveIcon \/>/);
  });

  it("gives the two self-silences the same icons as the dock", () => {
    const menus = readFileSync("src/components/shell/SidebarMenus.tsx", "utf8");

    assert.match(menus, /<MicIcon off=\{!selfControls\.mic\} \/>/);
    assert.match(menus, /<HeadsetIcon off=\{selfControls\.deafen\} \/>/);
  });

  it("will not let a menu undo a silence the dock could not", () => {
    // An owner's mute and the AFK channel's are not a member's to lift, from
    // the dock or from anywhere else. Offering it as if they could is worse
    // than not offering it.
    const menus = readFileSync("src/components/shell/SidebarMenus.tsx", "utf8");
    const rail = readFileSync("src/components/shell/ChannelRail.tsx", "utf8");

    assert.match(menus, /disabled=\{!selfControls\.micEnabled\}/);
    assert.match(menus, /disabled=\{!selfControls\.deafenEnabled\}/);
    assert.match(rail, /micEnabled: !props\.micLockedByRoom/);
    assert.match(rail, /&& !props\.voiceModeration\.muted/);
  });

  it("offers them in the member list as well as the channel rail", () => {
    const panel = readFileSync("src/components/shell/MemberPanel.tsx", "utf8");

    assert.match(panel, /selfControls=\{selfControls\}/);
    assert.match(panel, /const canRename = isSelf \|\|/);
  });

  it("asks before signing a device out", () => {
    // It cannot be undone from here — that Device has to link again — so a
    // mis-click deserves a question rather than a consequence.
    assert.match(devices(), /setConfirming\(device\)/);
    assert.match(devices(), /devices\.signOutTitle/);
    for (const language of ["en", "tr"] as const) {
      assert.ok(translate(language, "devices.signOutCopy", { device: "X" }).includes("X"));
    }
  });
});

describe("typing a recovery code", () => {
  it("groups it the way it was written down", () => {
    assert.equal(formatRecoveryCodeInput("JJRD7KBHHWJRZYB64XY2H05SY"), "JJRD7-KBHHW-JRZYB-64XY2-H05SY");
    assert.equal(formatRecoveryCodeInput("jjrd7 kbhhw"), "JJRD7-KBHHW");
  });

  it("folds the confusable glyphs, which matters most on the long code", () => {
    // Nobody checks a twenty-five character string against the screen twice.
    assert.equal(formatRecoveryCodeInput("ILO"), "110");
  });

  it("only calls it complete at twenty-five characters", () => {
    assert.equal(isCompleteRecoveryCode("JJRD7-KBHHW-JRZYB-64XY2-H05S"), false);
    assert.equal(isCompleteRecoveryCode("JJRD7-KBHHW-JRZYB-64XY2-H05SY"), true);
  });

  it("wraps rather than scrolling sideways", () => {
    // Twenty-five characters and four dashes do not fit on one line at a size
    // anybody can check, and a field that scrolls hides the half being read.
    const screen = readFileSync("src/features/auth/RecoverScreen.tsx", "utf8");
    const styles = readFileSync("src/styles.css", "utf8");

    assert.match(screen, /<textarea/);
    assert.match(styles, /\.recovery-input \{[\s\S]{0,600}white-space: normal/);
    // And it cannot be dragged over the page: a textarea is user-resizable by
    // default, and this one exists to wrap twenty-nine characters.
    assert.match(styles, /\.recovery-input \{[\s\S]{0,400}resize: none/);
  });
});

describe("the link dialog when a code runs out", () => {
  const dialog = () => readFileSync("src/features/auth/LinkDeviceDialog.tsx", "utf8");

  it("takes the copy button away with the code", () => {
    // Offering it invites a member to carry a code that will be refused.
    assert.match(dialog(), /\{code && !expired \?/);
  });

  it("puts the way out on top of what stopped working", () => {
    assert.match(dialog(), /className="btn btn-primary link-renew"/);
    assert.match(readFileSync("src/styles.css", "utf8"), /\.link-code-block\.is-expired[\s\S]{0,200}filter: blur/);
  });
});

describe("the signed-out screens", () => {
  it("show the mark alone, not one server's name", () => {
    // A member arriving here may belong to several servers, and "The Basement"
    // is one of them rather than the product.
    for (const path of ["src/features/auth/LinkDeviceScreen.tsx", "src/features/auth/RecoverScreen.tsx"]) {
      assert.match(readFileSync(path, "utf8"), /<BrandLockup subtitle="" \/>/);
    }
  });
});

describe("copying a code", () => {
  it("has a fallback for the insecure origins this is used on", () => {
    // `navigator.clipboard` does not exist outside a secure context, and
    // linking a phone over a local address by IP is exactly that. The button
    // did nothing at all and said nothing about it.
    const copy = readFileSync("src/lib/copyText.ts", "utf8");

    assert.match(copy, /navigator\.clipboard\?\.writeText/);
    assert.match(copy, /document\.execCommand\("copy"\)/);
  });

  it("says so when it could not copy", () => {
    for (const language of ["en", "tr"] as const) {
      assert.ok(translate(language, "common.copyFailed").length > 0);
    }
  });
});
