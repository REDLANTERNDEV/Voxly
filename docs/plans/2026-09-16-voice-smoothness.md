# Voice Smoothness and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Voxly voice start cleanly and recover from short-lived P2P media degradation without requiring members to leave and rejoin.

**Architecture:** Keep the existing peer-to-peer media topology. Make microphone ownership single-source during the transition from the microphone test to a voice room, initialize the optional AudioWorklet filter with the actual preference before its first audio block, and expose per-peer quality recovery requests from the observational stats sampler to the existing peer-recovery owner. Recovery remains bounded, generation-safe, and cooldown-limited.

**Tech Stack:** React 19, TypeScript, WebRTC `RTCPeerConnection` statistics and ICE restart, Web Audio API/AudioWorklet, Vitest-style Node test runner, npm workspaces.

## Global Constraints

- Preserve the current peer-to-peer media architecture; do not introduce an SFU, server-side media processing, recording, or a new runtime dependency.
- Keep native browser `echoCancellation`, `autoGainControl`, and `noiseSuppression` capture constraints unchanged in this fix; the Voxly extra filter preference remains separate.
- The quality sampler remains observational: it may produce recovery requests, but it must not close, rebuild, or directly mutate a peer connection.
- Recovery must be per-peer, generation-safe, single-flight, cooldown-limited, and use the existing deterministic-offerer/ICE-restart path.
- Preserve the existing `breaking` quality presentation and reconnect/rebuild fallback behavior.
- Add focused regression coverage for every changed media lifecycle or recovery invariant.
- Preserve unrelated working-tree changes, including the pre-existing `.gitignore` modification.
- Do not stage or commit changes unless explicitly requested by the user.

---

## File Map

- Modify `apps/web/public/noise-suppressor.worklet.js`: initialize the worklet enabled state from `processorOptions` before processing starts.
- Modify `apps/web/src/lib/microphoneInput.ts`: pass the current extra-filter preference into the `AudioWorkletNode` constructor.
- Modify `apps/web/src/App.tsx`: stop a pre-join microphone test before voice capture is opened.
- Modify `apps/web/src/lib/voicePeerRecovery.ts`: extend the pure peer-recovery state machine for quality-triggered recovery.
- Modify `apps/web/src/lib/useVoiceQuality.ts`: retain recovery state by peer identity and expose one-shot requests.
- Modify `apps/web/src/app/useListenerAudio.ts`: consume sampler requests and call `voice.recoverPeer`.
- Modify `apps/web/src/lib/useVoiceMedia.ts`: route quality recovery through `schedulePeerRecovery`/`recoverPeer` and guard single-flight behavior.
- Modify `apps/web/test/noise-suppressor-worklet.test.ts`, `apps/web/test/voice-media-lifecycle.test.ts`, and `apps/web/test/voice-quality.test.ts` for focused regression coverage.
- Update any web test fixtures that construct `VoiceQuality` values.
- Use `docs/designs/2026-09-16-voice-smoothness.md` as the behavior reference; no public UI copy or operator configuration is required.

## Recovery Interfaces

Use one shared request shape:

    export interface VoiceQualityRecoveryRequest {
      peerUserId: string;
      requestId: number;
    }

Extend the public `VoiceQuality` value with:

    recoveryRequests: readonly VoiceQualityRecoveryRequest[];

Extend the `PeerRecoveryEvent` union in `apps/web/src/lib/voicePeerRecovery.ts` with:

    | { type: "quality_degraded" };

`quality_degraded` transitions a stable peer to `restarting` with the existing `restart_ice` action and returns `wait` if that peer is already in `grace`, `restarting`, or `rebuilding`.

## Task 1: Make the optional AudioWorklet filter transparent when disabled

**Files:**
- Modify `apps/web/public/noise-suppressor.worklet.js`.
- Modify `apps/web/src/lib/microphoneInput.ts`.
- Test `apps/web/test/noise-suppressor-worklet.test.ts` and `apps/web/test/voice-media-lifecycle.test.ts`.

**Interfaces:** The worklet consumes `noiseSuppression` from `createMicrophoneInput` and receives it synchronously through `processorOptions.enabled`.

- [x] **Step 1: Write the failing test.** Update the test constructor type to accept an options object and add:

      it("starts disabled when constructed with a disabled preference", () => {
        const processor = new ProcessorClass({
          processorOptions: { enabled: false }
        });
        const input = noise(SAMPLE_RATE, 0.05, 19);
        assert.deepEqual(run(processor, input), input);
      });

The assertion must run before any `port.onmessage` call.

- [x] **Step 2: Verify red.** Run the focused worklet test. It failed because the processor defaulted to enabled.

- [x] **Step 3: Implement the minimal fix.** In the worklet constructor, set `this.enabled = options?.processorOptions?.enabled !== false` before the existing STFT state is used. Keep the existing message handler and processing algorithm unchanged.

      const node = new AudioWorkletNode(context, noiseSuppressorProcessorName, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { enabled: noiseSuppression }
      });

Keep the existing `port.postMessage({ enabled: noiseSuppression })` for later preference changes.

- [x] **Step 4: Add a source-level assertion** in `voice-media-lifecycle.test.ts` that `AudioWorkletNode` receives `processorOptions: { enabled: noiseSuppression }`.

- [x] **Step 5: Verify green.** Focused worklet and lifecycle tests pass; existing disabled passthrough and runtime-toggle tests remain green.

## Task 2: Enforce single microphone ownership during pre-join voice entry

**Files:** Modify `apps/web/src/App.tsx`; test `apps/web/test/voice-media-lifecycle.test.ts`.

**Interfaces:** Consume `audio.microphoneTest.active`, `audio.stopMicrophoneTest`, and `audio.voice.activeRoomId`; produce an async `onJoinVoice` handler.

- [x] **Step 1: Write the failing ordering assertion.** Inspect the `onJoinVoice` source segment and assert it contains `audio.microphoneTest.active`, `audio.stopMicrophoneTest`, and `!audio.voice.activeRoomId`, with `stopMicrophoneTest` appearing before `joinVoiceWithAudioUnlock`.

      assert.ok(joinSource.includes("audio.microphoneTest.active"));
      assert.ok(joinSource.includes("audio.stopMicrophoneTest"));
      assert.ok(joinSource.includes("!audio.voice.activeRoomId"));
      assert.ok(joinSource.indexOf("audio.stopMicrophoneTest") < joinSource.indexOf("joinVoiceWithAudioUnlock"));

- [x] **Step 2: Verify red.** The ordering assertion failed against the original inline join callback.

- [x] **Step 3: Implement the wrapper.** Replace the inline callback with an async callback equivalent to:

      const onJoinVoice = useCallback(
        async (roomId: string, options: VoiceJoinRequest = {}) => {
          if (!audio.voice.activeRoomId && audio.microphoneTest.active) {
            await audio.stopMicrophoneTest();
          }
          return joinVoiceWithAudioUnlock(
            roomId,
            unlockSharedAudioOutput,
            releaseUnusedSharedAudioOutput,
            (nextRoomId) => audio.voice.join(
              nextRoomId, options.visualTargets ?? [], options
            )
          );
        },
        [audio.microphoneTest.active, audio.stopMicrophoneTest,
         audio.voice.activeRoomId, audio.voice.join,
         releaseUnusedSharedAudioOutput, unlockSharedAudioOutput]
      );

Pass this callback to `ShellActions`. Do not stop the test after joining. The `!activeRoomId` guard preserves the already-in-voice shared monitor path.

- [x] **Step 4: Verify.** Lifecycle tests and web typecheck pass.

## Task 3: Add a quality-triggered recovery transition with single-flight behavior

**Files:** Modify `apps/web/src/lib/voicePeerRecovery.ts` and `apps/web/src/lib/useVoiceMedia.ts`; test `apps/web/test/voice-quality.test.ts` and existing peer lifecycle coverage.

**Interfaces:** Use the existing `PeerRecoveryState`, `advancePeerRecovery`, `initialPeerRecoveryState`, deterministic offerer rule, and `peerRecoveryStatesRef`; do not add a second recovery model.

- [x] **Step 1: Write failing pure tests.** Add:

      it("starts an ICE restart after quality degradation on a stable peer", () => {
        const result = advancePeerRecovery(stablePeerRecoveryState,
          { type: "quality_degraded" }, 1000);
        assert.equal(result.action, "restart_ice");
        assert.equal(result.state.phase, "restarting");
      });

      it("waits while a peer is already recovering", () => {
        const result = advancePeerRecovery(restartingPeerRecoveryState,
          { type: "quality_degraded" }, 1000);
        assert.equal(result.action, "wait");
        assert.equal(result.state.phase, "restarting");
      });

- [x] **Step 2: Verify red.** The test build failed because the event was absent.

- [x] **Step 3: Implement the pure transition.** In `apps/web/src/lib/voicePeerRecovery.ts`, extend the event union. For `quality_degraded`, return `{ state: { ...state, phase: "restarting" }, action: "restart_ice" }` only when `state.phase === "stable"`; otherwise return `{ state, action: "wait" }`. Preserve existing timestamps, retry limits, rebuild actions, and connected reset behavior.

- [x] **Step 4: Route `recoverPeer` through the transition.** In `useVoiceMedia.ts`, get or create the peer, read the current state, call `advancePeerRecovery(current, { type: "quality_degraded" }, Date.now())`, store the returned state, and call the existing `requestPeerRecovery(peerUserId, peer)` only when the action is `restart_ice`. Use the existing `initialPeerRecoveryState()` initializer and `schedulePeerRecoveryRef` path for later restart failure/rebuild handling.

      const peer = peersRef.current.get(peerUserId) ?? ensurePeer(peerUserId);
      if (!peer) return;
      const current = peerRecoveryStatesRef.current.get(peerUserId)
        ?? createInitialPeerRecoveryState();
      const transition = advancePeerRecovery(current,
        { type: "quality_degraded" }, Date.now());
      peerRecoveryStatesRef.current.set(peerUserId, transition.state);
      if (transition.action === "restart_ice") {
        requestPeerRecovery(peerUserId, peer);
      }

Ensure the recovery-request signaling path reaches this guarded method before the deterministic offerer sends the restart offer; do not bypass the state map with a second direct ICE-restart path.

- [x] **Step 5: Verify.** Peer recovery, quality, and lifecycle tests pass; existing ICE failure and rebuild tests remain green.

## Task 4: Expose per-peer recovery requests from the quality sampler

**Files:** Modify `apps/web/src/lib/useVoiceQuality.ts`, `apps/web/src/app/useListenerAudio.ts`, and the public `VoiceQuality` type; update related fixtures; test `voice-quality.test.ts` and `voice-media-lifecycle.test.ts`.

**Interfaces:** Consume `VoiceStatsPeer.userId` and `updateVoiceQualityRecovery`; produce `VoiceQuality.recoveryRequests` and an outer effect that invokes `voice.recoverPeer`.

- [x] **Step 1: Write failing wiring tests.** Assert that `useVoiceQuality.ts` contains `updateVoiceQualityRecovery`, `userId`, and `recoveryRequests`, but does not contain a direct `recoverPeer(` call. Assert that `useListenerAudio.ts` contains both `voiceQuality.recoveryRequests` and `voice.recoverPeer`.

- [x] **Step 2: Verify red.** The test build failed because the field and wiring did not exist.

- [x] **Step 3: Add per-peer sampler state.** Add the request interface above. Keep a `Map<string, VoiceQualityRecoveryState>` ref and a numeric request-id ref. For each current `{ userId, peer }`, calculate the existing reading, pass it to `updateVoiceQualityRecovery`, and append `{ peerUserId: userId, requestId: ++requestIdRef.current }` only when it returns `recover: true`. Remove departed peers from the map. Return `recoveryRequests: []` with no active room or peers. Keep quality grading and transport calculations unchanged.

- [x] **Step 4: Preserve sampler ownership.** The sampler must not call `recoverPeer`, close a peer, rebuild a peer, or emit signaling. It only updates its own refs and returns request data.

- [x] **Step 5: Consume requests in `useListenerAudio`.** Add:

      useEffect(() => {
        for (const request of voiceQuality.recoveryRequests) {
          voice.recoverPeer(request.peerUserId);
        }
      }, [voice.recoverPeer, voiceQuality.recoveryRequests]);

Keep the current stats source and do not call recovery from render or directly inside the interval callback.

- [x] **Step 6: Update fixtures.** Search for `VoiceQuality` object literals in web tests and add `recoveryRequests: []`; do not make the field optional.

- [x] **Step 7: Verify.** Focused quality and lifecycle tests pass; existing observational-sampler assertions remain green.

## Task 5: Full verification and browser smoke check

**Files:** No planned new files. Inspect implementation, tests, and status.

- [x] **Step 1:** Run `npm test -w @voxly/web`; 673 tests pass and 0 fail.

- [x] **Step 2:** Run `npm run typecheck` and `npm run build`; both pass with the existing Vite chunk-size warning.

- [x] **Step 3:** Run `git -c core.fsmonitor=false diff --check` and `git -c core.fsmonitor=false status --short`; no whitespace errors and the pre-existing `.gitignore` change is preserved.

- [ ] **Step 4: Browser smoke check.** Pending a live two-browser session; automated coverage and build verification are complete.

- [x] **Step 5: Final review.** Implementation preserves P2P, TURN policy, codecs, native processing flags, public configuration, and unrelated UI behavior.
