# Noise Suppression Quality Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with a fresh test cycle for each task. The repository workflow does not authorize automatic commits, so leave commits to the user unless explicitly requested.

**Goal:** Make Voxly's extra microphone filter opt-in while keeping the browser's native noise suppression enabled, preventing the reported crackling by default.

**Architecture:** Keep the existing Web Audio and AudioWorklet paths intact for users who explicitly enable Voxly's extra filter. Change only the preference default and storage version so old default-on values are ignored, then clarify the UI and repository media guidance.

**Tech Stack:** TypeScript, React 19, Web Audio API, AudioWorklet, Node.js test runner, npm workspaces.

## Global Constraints

- Keep noiseSuppression: true, autoGainControl: true, and echoCancellation: true in browser capture constraints.
- Do not change the peer-to-peer WebRTC topology or microphone capture/replacement lifecycle.
- Store the preference per user and use the new v2 storage key; old v1 values must not enable the extra filter.
- Add English and Turkish copy in the same change.
- Preserve recoverable fallback behavior when Web Audio or the optional AudioWorklet is unavailable.
- Use apply_patch for source edits and do not add dependencies.
- Do not stage or commit changes unless the user explicitly asks for it.

---

## File Map

- Modify apps/web/src/lib/noiseSuppression.ts: set the opt-in default and version the preference key.
- Modify apps/web/src/lib/microphoneInput.ts: keep direct helper calls consistent with the opt-in default.
- Modify apps/web/src/lib/i18n.ts: clarify that the switch controls Voxly's additional filter.
- Modify apps/web/src/lib/AGENTS.md: align media guidance with the new default.
- Modify apps/web/test/noise-suppression.test.ts: cover v2 storage and migration behavior.
- Modify apps/web/test/microphone-input.test.ts: cover the direct graph default.
- Modify apps/web/test/i18n.test.ts: cover both localized additional-filter hints.
- Modify docs/designs/2026-09-04-noise-suppression-quality.md only if implementation findings require a design correction.

## Task 1: Make the extra filter opt-in and ignore legacy default-on values

**Files:**

- Modify: apps/web/src/lib/noiseSuppression.ts:1-38
- Test: apps/web/test/noise-suppression.test.ts:28-75

**Interfaces:**

- Preserve DEFAULT_NOISE_SUPPRESSION: boolean.
- Preserve noiseSuppressionStorageKey(userId: string): string.
- Preserve readNoiseSuppression(userId: string, storage?): boolean and writeNoiseSuppression(userId: string, enabled: boolean, storage?): void.

- [ ] **Step 1: Write the failing tests**

Update the preference tests so they express the new behavior:

~~~ts
it("defaults the Voxly extra filter off", () => {
  assert.equal(DEFAULT_NOISE_SUPPRESSION, false);
});

it("uses a v2 key and ignores the old default-on value", () => {
  const storage = memoryStorage();
  storage.setItem("voxly:noise-suppression:v1:user-a", JSON.stringify(true));

  assert.equal(noiseSuppressionStorageKey("user-a"), "voxly:noise-suppression:v2:user-a");
  assert.equal(readNoiseSuppression("user-a", storage), false);
});

it("persists an explicit v2 opt-in independently per user", () => {
  const storage = memoryStorage();

  writeNoiseSuppression("user-a", true, storage);
  writeNoiseSuppression("user-b", false, storage);

  assert.equal(readNoiseSuppression("user-a", storage), true);
  assert.equal(readNoiseSuppression("user-b", storage), false);
});
~~~

Keep the malformed-value and unavailable-storage tests, changing their expected fallback to DEFAULT_NOISE_SUPPRESSION where necessary.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

~~~bash
npm test -w @voxly/web -- --test-name-pattern="noise suppression preference"
~~~

Expected: FAIL because the implementation still returns true by default and still reads/writes the v1 key.

- [ ] **Step 3: Implement the minimal preference change**

In apps/web/src/lib/noiseSuppression.ts, make the default and key version explicit:

~~~ts
export const DEFAULT_NOISE_SUPPRESSION = false;

export function noiseSuppressionStorageKey(userId: string) {
  return "voxly:noise-suppression:v2:" + userId;
}
~~~

Update the adjacent comments to say that the browser's native suppression remains on while Voxly's additional filter is opt-in. Do not add a migration that copies v1; ignoring the legacy key is the required migration behavior.

- [ ] **Step 4: Run the focused test and verify it passes**

Run the same focused command. Expected: all tests in the noise suppression preference suite pass, including the explicit v2 opt-in case.

## Task 2: Keep direct microphone graph construction aligned with the new default

**Files:**

- Modify: apps/web/src/lib/microphoneInput.ts:60-63
- Test: apps/web/test/microphone-input.test.ts:189-235

**Interfaces:**

- Preserve createMicrophoneInput(rawStream, initialVolume, options?): MicrophoneInput.
- Preserve explicit noiseSuppression: true behavior, including the existing AudioWorklet path.

- [ ] **Step 1: Write the failing regression test**

Add a test in describe("capture-graph noise suppression", ...) that omits the option and proves the fallback graph stays open:

~~~ts
it("keeps the extra filter off when no preference is supplied", () => {
  const graph = audioGraph();
  createMicrophoneInput(graph.raw as unknown as MediaStream, 100, graph.options);

  for (let tick = 0; tick < 40; tick += 1) graph.ticks[0]();

  assert.equal(graph.highPass.frequency.value, noiseGateBypassHz);
  assert.equal(graph.gate.gain.value, noiseGateOpenGain);
});
~~~

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

~~~bash
npm test -w @voxly/web -- --test-name-pattern="capture-graph noise suppression"
~~~

Expected: FAIL because createMicrophoneInput currently falls back to true when options.noiseSuppression is omitted.

- [ ] **Step 3: Implement the minimal graph default change**

In apps/web/src/lib/microphoneInput.ts, change only the fallback value:

~~~ts
let noiseSuppression = options.noiseSuppression ?? false;
~~~

Leave the graph shape, timers, AudioWorklet loading, toggle behavior, and disposal logic unchanged.

- [ ] **Step 4: Run the focused test and verify it passes**

Run the same focused command. Expected: the new omitted-option test and all existing explicit-on/off graph tests pass.

## Task 3: Clarify the switch and repository media guidance in both languages

**Files:**

- Modify: apps/web/src/lib/i18n.ts:537-539 and 1127-1129
- Test: apps/web/test/i18n.test.ts:20-30
- Modify: apps/web/src/lib/AGENTS.md:164-198

**Interfaces:**

- Preserve the translation keys audio.noiseSuppression, audio.noiseSuppressionHint, and audio.noiseSuppressionUnsupported.
- Preserve the existing switch accessibility structure and label ids.

- [ ] **Step 1: Write the failing localization assertions**

Extend the existing noise suppression localization test with the hint text:

~~~ts
assert.match(translate("en", "audio.noiseSuppressionHint"), /additional|extra/i);
assert.match(translate("tr", "audio.noiseSuppressionHint"), /ek|ilave/i);
~~~

- [ ] **Step 2: Run the focused localization test and verify it fails**

Run:

~~~bash
npm test -w @voxly/web -- --test-name-pattern="translates the noise suppression control"
~~~

Expected: FAIL if the current hint does not explicitly describe the filter as optional Voxly processing in both languages.

- [ ] **Step 3: Update the copy and guidance**

Use copy with this meaning:

- English: “Optional extra filtering by Voxly, on top of your browser's built-in suppression. Off keeps the browser filter on.”
- Turkish: the localized equivalent, stating that Voxly's filter is optional and that disabling it leaves the browser filter enabled.

Update the Microphone Gain and Monitoring guidance to say the stored Voxly preference defaults off, while browser-native suppression remains requested on. Keep the statements about plain booleans, the AudioWorklet fallback, and live-graph toggling.

- [ ] **Step 4: Run the focused localization test and verify it passes**

Run the same focused command. Expected: both localized hint assertions pass.

## Task 4: Run affected-workspace verification

**Files:**

- Verify: apps/web/src/lib/noiseSuppression.ts
- Verify: apps/web/src/lib/microphoneInput.ts
- Verify: apps/web/src/lib/i18n.ts
- Verify: apps/web/src/lib/AGENTS.md
- Verify: apps/web/test/noise-suppression.test.ts
- Verify: apps/web/test/microphone-input.test.ts
- Verify: apps/web/test/i18n.test.ts

- [ ] **Step 1: Run the complete web test suite**

Run:

~~~bash
npm test -w @voxly/web
~~~

Expected: exit code 0 with zero failed tests.

- [ ] **Step 2: Run typecheck and build**

Run:

~~~bash
npm run typecheck -w @voxly/web
npm run build -w @voxly/web
~~~

Expected: both commands exit 0.

- [ ] **Step 3: Check patch hygiene and working-tree scope**

Run:

~~~bash
git diff --check
git status --short
~~~

Expected: no whitespace errors, and only the planned preference, graph-default, copy/guidance, tests, and already-existing user changes are present.
