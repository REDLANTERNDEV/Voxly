# Voice Connection Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep individual voice peers recoverable through transient ICE disconnects, route changes, packet-loss bursts, and signaling races without leaving the member stuck on `connecting`.

**Architecture:** Add pure, tested peer-recovery and transport-stat helpers, then wire them into the existing `useVoiceMedia` lifecycle. ICE `disconnected` gets a grace period and a single restart attempt before peer rebuild; `failed` rebuilds only the affected peer. Each peer callback is generation-checked so stale signaling and timers cannot mutate its replacement. Socket.IO RTT and WebRTC media RTT remain separate.

**Tech Stack:** React 19, strict TypeScript, browser WebRTC APIs, Socket.IO, Node test runner, existing English/Turkish i18n.

## Global Constraints

- Preserve the browser-to-browser WebRTC mesh and authenticated Coturn fallback; do not introduce an SFU, recording, or server-side media processing.
- Keep Cloudflare/reverse-proxy signaling separate from the DNS-only Coturn media path.
- Preserve the shared offerer/polite-peer rules and the recvonly audio transceiver invariant.
- Cleanup must be idempotent and stale callbacks must not mutate replacement generations.
- Voice recovery must use the existing ten-minute resume window and acknowledged `voice:join` sequence.
- Keep English and Turkish user-facing copy behaviorally equivalent.
- Do not expose TURN credentials, tokens, raw SDP, or raw signaling payloads in logs or UI.
- Do not stage or commit changes unless the user explicitly requests it.

---

### Task 1: Add pure peer-recovery state transitions

**Files:**
- Create: `apps/web/src/lib/voicePeerRecovery.ts`
- Create: `apps/web/test/voice-peer-recovery.test.ts`

**Interfaces:**
- Produces `PeerRecoveryPhase`, `PeerRecoveryAction`, `PeerRecoveryState`, `initialPeerRecoveryState`, and `advancePeerRecovery` for `useVoiceMedia.ts`.
- The helper accepts only current state, an event, and a timestamp; it must not access browser APIs, timers, sockets, or React state.

- [x] **Step 1: Write the failing tests**

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  advancePeerRecovery,
  initialPeerRecoveryState,
  type PeerRecoveryState
} from "../src/lib/voicePeerRecovery.js";

describe("peer recovery state", () => {
  it("waits through a transient disconnected state", () => {
    const next = advancePeerRecovery(initialPeerRecoveryState(), { type: "disconnected" }, 1_000);
    assert.equal(next.state.phase, "grace");
    assert.equal(next.action, "wait");
  });

  it("requests one ICE restart after the grace deadline", () => {
    let current: PeerRecoveryState = advancePeerRecovery(initialPeerRecoveryState(), { type: "disconnected" }, 1_000).state;
    const next = advancePeerRecovery(current, { type: "grace_elapsed" }, 4_100);
    assert.equal(next.state.phase, "restarting");
    assert.equal(next.action, "restart_ice");
  });

  it("rebuilds a failed peer and backs off repeated failures", () => {
    const next = advancePeerRecovery(initialPeerRecoveryState(), { type: "failed" }, 1_000);
    assert.equal(next.state.phase, "rebuilding");
    assert.equal(next.action, "rebuild_peer");
    assert.ok(next.state.nextRetryAt > 1_000);
  });

  it("cancels recovery when the peer becomes connected or leaves", () => {
    const disconnected = advancePeerRecovery(initialPeerRecoveryState(), { type: "disconnected" }, 1_000).state;
    const connected = advancePeerRecovery(disconnected, { type: "connected" }, 1_100);
    assert.equal(connected.state.phase, "stable");
    assert.equal(connected.action, "cancel");

    const leaving = advancePeerRecovery(disconnected, { type: "member_left" }, 1_200);
    assert.equal(leaving.state.phase, "idle");
    assert.equal(leaving.action, "cancel");
  });
});
```

- [x] **Step 2: Run the focused test and verify the expected failure**

Run: `npm run build -w @voxly/web && node --test apps/web/dist/test/voice-peer-recovery.test.js`

Expected: FAIL because `voicePeerRecovery.ts` and its exported transitions do not exist yet.

- [x] **Step 3: Implement the minimal pure state machine**

Implement a three-second grace window and bounded retry delays of 0 ms, 1,000 ms, 2,000 ms, and 5,000 ms. `disconnected` enters `grace`; `grace_elapsed` enters `restarting` and returns `restart_ice`; `failed` enters `rebuilding` and returns `rebuild_peer`; `connected` and `member_left` return `cancel` with `stable` or `idle` respectively. A `restart_succeeded` event returns to `stable`; `restart_failed` returns to `rebuilding` with the next delay.

- [x] **Step 4: Run the focused test and verify it passes**

Run: `npm run build -w @voxly/web && node --test apps/web/dist/test/voice-peer-recovery.test.js`

Expected: PASS.

### Task 2: Separate media transport measurements from Socket.IO RTT

**Files:**
- Modify: `apps/web/src/lib/voiceQuality.ts`
- Modify: `apps/web/src/lib/useVoiceQuality.ts`
- Modify: `apps/web/test/voice-quality.test.ts`

**Interfaces:**
- Add `VoiceTransportReading` with `rttMs: number | null`, `candidateType: string | null`, and `candidatePairState: string | null`.
- Add `readVoiceTransport(report: Iterable<Record<string, unknown>>): VoiceTransportReading`.
- `useVoiceQuality` may include transport detail in the existing `VoiceQuality` result, but it must not use Socket.IO health values.

- [x] **Step 1: Write the failing transport-stat tests**

```typescript
it("reads the selected WebRTC candidate pair without using signaling RTT", () => {
  const reading = readVoiceTransport([
    { type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.18, localCandidateId: "local", remoteCandidateId: "remote" },
    { type: "local-candidate", id: "local", candidateType: "relay" },
    { type: "remote-candidate", id: "remote", candidateType: "relay" }
  ]);

  assert.deepEqual(reading, { rttMs: 180, candidateType: "relay", candidatePairState: "succeeded" });
});
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `npm run build -w @voxly/web && node --test apps/web/dist/test/voice-quality.test.js`

Expected: FAIL because `readVoiceTransport` does not exist.

- [x] **Step 3: Implement transport extraction**

Select the nominated/succeeded candidate pair, resolve its local and remote candidate records, convert `currentRoundTripTime` seconds to rounded milliseconds, and return `null` values when stats are missing or unsupported. Prefer `candidateType: "relay"` if either side is relay; otherwise return the available candidate type. Never read `useConnectionHealth` or a Socket.IO probe from this helper.

- [x] **Step 4: Integrate transport readings without changing the quality grade contract**

Collect the transport reading from each live peer in `useVoiceQuality`, retain the worst audio quality behavior, and expose the selected transport detail only for the active-call presentation. A missing transport stat remains recoverable and must not turn a peer red.

- [x] **Step 5: Run the focused tests**

Run: `npm run build -w @voxly/web && node --test apps/web/dist/test/voice-quality.test.js`

Expected: PASS.

### Task 3: Harden peer lifecycle and ICE recovery

**Files:**
- Modify: `apps/web/src/lib/useVoiceMedia.ts`
- Modify: `apps/web/src/lib/voiceNegotiation.ts`
- Modify: `apps/web/test/voice-media-lifecycle.test.ts`
- Modify: `apps/web/test/voice-signal.test.ts`

**Interfaces:**
- `useVoiceMedia` remains the owner of browser side effects and returns the existing public shape plus the existing `recoverPeer` hook used by quality sampling.
- `voiceNegotiation.ts` may expose only pure state/status helpers; shared offerer rules remain re-exports from `@voxly/shared`.

- [x] **Step 1: Add source-level regression tests before implementation**

Add assertions that the peer setup registers `oniceconnectionstatechange`, uses the pure recovery transition helper, schedules a grace timer for `disconnected`, calls `restartIce()` before peer rebuild, and checks the current peer generation before handling an ICE callback. Add a signal test that candidates from a replaced peer are not flushed into the replacement.

- [x] **Step 2: Run the focused tests and verify the new assertions fail**

Run: `npm run build -w @voxly/web && node --test apps/web/dist/test/voice-media-lifecycle.test.js apps/web/dist/test/voice-signal.test.js`

Expected: FAIL on the new lifecycle assertions.

- [x] **Step 3: Add per-peer generation and recovery refs**

Track a monotonically increasing generation per peer user id and store the generation on each `RTCPeerConnection` closure. Every `onicecandidate`, `ontrack`, `onconnectionstatechange`, `oniceconnectionstatechange`, timer callback, and async offer/answer continuation must verify both `peersRef.current.get(peerUserId) === peer` and the generation before mutating state.

- [x] **Step 4: Implement ICE state handling**

On `iceConnectionState === "disconnected"`, enter the pure grace state and schedule one generation-checked timer. When the timer fires, call `restartIce()` and send a fresh offer only if the peer is still current, the room is still active, and signaling is stable or can safely queue an offer. On `failed`, cancel the grace timer and use the existing isolated peer rebuild path. On `connected` or `completed`, cancel recovery state and clear the connecting/recovery presentation.

- [x] **Step 5: Make candidate queues generation-aware**

Store pending candidates with the peer generation. Clear them during peer replacement and ignore candidates whose generation no longer matches. Preserve the existing ignored-glare behavior and 128-candidate bound.

- [x] **Step 6: Keep recovery single-flight and bounded**

Prevent simultaneous quality recovery, ICE restart, failed rebuild, and offer creation for one peer. Reuse existing cleanup paths so leave, room changes, socket disconnects, authoritative snapshot removal, and component cleanup cancel timers and invalidate callbacks.

- [x] **Step 7: Run focused web tests and typecheck**

Run: `npm run build -w @voxly/web && node --test apps/web/dist/test/voice-media-lifecycle.test.js apps/web/dist/test/voice-signal.test.js apps/web/dist/test/voice-peer-recovery.test.js && npm run typecheck -w @voxly/web`

Expected: PASS with no TypeScript errors.

### Task 4: Present bounded recovery and separate media RTT in both languages

**Files:**
- Modify: `apps/web/src/lib/i18n.ts`
- Modify: `apps/web/src/app/presentation.tsx`
- Modify: `apps/web/src/components/shell/VoiceDock.tsx`
- Modify: `apps/web/src/features/voice/VoicePresentation.tsx`
- Modify: `apps/web/test/voice-status-presentation.test.tsx`

**Interfaces:**
- Reuse the existing `Translate` and `VoiceQuality` contracts; no new Socket.IO event or shared DTO is required.

- [x] **Step 1: Add failing presentation assertions**

Cover that active calls use media quality/transport state, the UI does not label Socket.IO RTT as voice RTT, and prolonged recovery has a Turkish and English string distinct from an unbounded `connecting` state.

- [x] **Step 2: Run the focused presentation test and verify failure**

Run: `npm run build -w @voxly/web && node --test apps/web/dist/test/voice-status-presentation.test.js`

Expected: FAIL on the new recovery/transport assertions.

- [x] **Step 3: Add paired translations and bounded status rendering**

Add concise English/Turkish copy for recovery and media-route detail. Keep raw candidate types and exact RTT out of the primary user-facing label unless the existing detail surface already exposes them. Show recovery only after the grace/restart threshold, and keep the member’s controls usable.

- [x] **Step 4: Run presentation tests and the web workspace suite**

Run: `npm run build -w @voxly/web && node --test apps/web/dist/test/voice-status-presentation.test.js && npm run test -w @voxly/web`

Expected: PASS.

### Task 5: Verify deployment-sensitive behavior

**Files:**
- Modify: `docs/designs/2026-09-10-voice-connection-reliability.md` only if implementation behavior materially differs from the approved design.

- [x] **Step 1: Run repository hygiene checks**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; pre-existing `.gitignore` changes remain untouched.

- [x] **Step 2: Run affected workspace verification**

Run: `npm run typecheck && npm run build && npm run test -w @voxly/web`.

Expected: typecheck and builds pass; web tests pass. If server tests fail with `listen EPERM` in the restricted environment, report that as an environment limitation rather than a product failure.

- [ ] **Step 3: Perform the production smoke test**

Use two devices on different networks. In `chrome://webrtc-internals`, confirm the selected candidate pair, candidate type, media RTT, and `bytesReceived`. Briefly switch networks or introduce a short network interruption, then verify audio returns without manually leaving and rejoining. Confirm that the Cloudflare/Socket.IO RTT and the WebRTC media RTT are reported as separate measurements.
