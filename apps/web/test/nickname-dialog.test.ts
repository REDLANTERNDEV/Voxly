import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("nickname dialog input lifecycle", () => {
  it("focuses and selects the nickname only on the initial mount", () => {
    const source = readFileSync("src/components/ui/Dialogs.tsx", "utf8");
    const dialog = source.match(/export function NicknameDialog[\s\S]*$/)?.[0] ?? "";
    const focusEffect = dialog.match(/useEffect\(\(\) => \{[\s\S]*?inputRef\.current\?\.focus\(\);[\s\S]*?inputRef\.current\?\.select\(\);[\s\S]*?\}, \[[^\]]*\]\);/)?.[0] ?? "";

    assert.match(focusEffect, /\}, \[\]\);$/);
    assert.doesNotMatch(focusEffect, /addEventListener/);
    assert.match(dialog, /useEffect\(\(\) => \{[\s\S]*?addEventListener\("keydown"[\s\S]*?\}, \[close, isSaving\]\);/);
  });
});
