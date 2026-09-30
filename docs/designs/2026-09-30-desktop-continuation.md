# Desktop continuation — 2026-09-30

Resume desktop implementation in `/Users/redlanterndev/Projects/Voxly`.
The user requested a new chat because the previous context was too long,
a complete progress note, and continued implementation. This is the entry
point for that new chat. Read current source and Git status before editing.

## Latest state and user acceptance

HEAD when this note was written: `4e17d807` — Add desktop in-app history and
PTT delay defaults. The user committed the implementation between turns.

The user's latest report: “yeah its working perfectly fine now.” This follows
Windows testing of desktop Back/Forward navigation while remaining connected
to voice. Earlier the user explicitly confirmed Push to talk and Push to mute
were working. Treat these as successful contributor smoke tests, not complete
release certification: Windows/WebView2 versions, full scenarios, duration,
and resource measurements were not supplied.

The required behavior is settled: Back/Forward changes only the viewed page.
It must not join an earlier voice channel, switch the active channel, leave,
or disconnect the current call. At either history boundary, further clicks
stop. Mouse4/Mouse5 retain page navigation even when assigned voice shortcuts.

## Completed work and important implementation seams

- Windows-first Tauri shell, bilingual local installation chooser, one active
  installation, per-origin WebView2 profiles, tray hiding and media probes.
  Voice, screen/computer audio, tray audio and permission errors have earlier
  positive smoke reports. Complete media/resource acceptance remains pending.
- Reviewed lifecycle bugs are repaired: pending voice joins hold deployment
  reload deferral through capture and acknowledgement; confirmed shell
  transitions dispose chooser probes and reject late capture results.
- Browser approval sign-in is implemented in the installation-delivered web
  interface. Session collection happens in its webview/profile. Existing Link
  code remains available. This adds no remote native IPC.
- Global mute/deafen and independent Push to talk/Push to mute shortcuts;
  keyboard and Mouse3/4/5 bindings, conflict validation, one action per physical
  press, ordered releases, and generation checks. The chooser owns registration.
- Microphone mode must be selected after saving its binding. PTT is silent
  while released and publishes while held; PTM suppresses while held and
  restores existing intent on release. Manual mute, deafen and owner/room locks
  win. Shortcuts never acquire a microphone or join voice.
- Sidebar, bottom dock and stage use effective microphone publication state
  while preserving separate manual-mute intent. PTT/PTM presentation was fixed.
- PTT release delay is adjustable 0–2000 ms with an ms readout. Selecting PTT
  from another mode enables 200 ms if the saved delay is zero; a saved nonzero
  value survives. Users can disable it while staying in PTT. Native Tokio
  expiry closes only an existing tail; fresh presses, manual mute/deafen,
  locks, room/device/reconnect transitions and generation changes invalidate
  grants. Background browser timers do not own the deadline.
- Desktop `src-tauri/src/navigation.js` is injected at exact origin/top frame.
  It owns document-local route history through native `replaceState`, handles
  Mouse4/5 and Alt+Left/Right/BrowserBack/Forward, emits `popstate`, and stops at
  boundaries. Entering `/app/` from authentication clears startup entries.
  New page selection discards forward entries. It has no native IPC. Native
  mouse hook remains pass-through for other applications and voice shortcuts.
- Background notifications use standard WebView2 `Notification`, opted in
  from installation Settings → Audio, with per-Account persistence, generic
  English/Turkish text, category/master/deafen gating, silent OS delivery and
  burst coalescing. Existing web cues own sound. Installed OS activation,
  identity, tray/lock behavior and deep links are still pending.

Key sources:

- `apps/desktop/src-tauri/src/{main.rs,platform.rs,mouse_hook.rs,shortcuts.rs,installations.rs}`
- `apps/desktop/src-tauri/src/{voice-bridge.js,navigation.js}`
- `apps/desktop/src/{main.ts,shortcuts.ts,i18n.ts}`
- `apps/web/src/lib/{desktopVoice.ts,desktopMicrophone.ts,desktopNotifications.ts,useVoiceMedia.ts}`
- `apps/web/src/app/{useListenerAudio.ts,useNotificationSounds.ts}`
- `apps/web/src/components/shell/VoiceDock.tsx`
- `apps/web/src/features/voice/VoiceRoomScreen.tsx`
- `apps/desktop/test/{shortcuts.test.ts,navigation.test.ts,native-boundary.test.ts}`
- Web desktop-microphone, hold-microphone-presentation and desktop-notifications tests.

## Continue with the next implementation step

Implement call-aware shell transitions using the existing desktop plan:
finite reporting of effective media and pending operations for disconnect,
switch, retry and quit decisions. Read ADR-0019/0020 and current shell
confirmation behavior first. Choose the smallest coherent slice, add focused
regression coverage, implement it, and verify affected workspaces. Report any
necessary extension of the one-way bridge explicitly and document its boundary.

A missing or stale report must require conservative confirmation. Keep
permission management, shortcut registration, installation selection, updater
configuration and release trust local. Remote content must not gain arbitrary
commands, filesystem access, script evaluation, registration, or updater
control. Preserve exact-origin, top-frame, active-installation and generation
validation. Keep finite payloads and versioning; use the existing voice lifecycle
rather than inventing parallel call state. Explicit confirmed termination
should end capture; cancelling should retain it. Failed replacement health
checks must preserve the old installation/call.

This chat may continue implementation autonomously within that scope. Ask only
for genuinely missing product decisions. Preserve working PTT/PTM, release
delay and document-local navigation. Do not re-diagnose the resolved Logitech
mouse issue unless new evidence reproduces it.

Later work: notification activation and routing-only deep links; signed shell
updater/distribution (requires real distributor endpoint and signing ownership,
never placeholder trust); installed Windows acceptance and complete process-tree
resource measurement; macOS/Linux adapters after Windows gates. Do not advertise
production completion based on a successful build.

Production UX requirements added on 2026-09-30 are recorded in
`2026-09-30-desktop-product-experience.md` and ADR-0023. After notification
activation/routing, move everyday settings into Audio, Shortcuts and
Notifications; make welcome connection-focused, remember the authenticated
Installation with a changeable startup choice, provide simple startup recovery,
match window chrome to Voxly theme and verify relaunch/update freshness. These
requirements supersede treating the current test chooser as the final welcome.

## Authoritative documents and workflow

Read repository/nested AGENTS.md, CONTEXT.md, and the desktop plan:
`docs/designs/2026-09-29-windows-desktop.md`, `docs/desktop.md`,
`docs/desktop-windows-acceptance.md`, ADR-0019 and ADR-0020.
The older untracked `2026-09-29-desktop-review-and-remaining-work.md` describes
historical bugs: its BUG-1/BUG-2 and old failed-test counts are superseded by
current source and the revised plan. Do not treat them as open again.

The user invoked ask-matt for routing. This is a completed implementation/QA
phase boundary; the user explicitly chose a fresh chat and persistent notes.
Use relevant skills for the next slice. Do not commit/stage/push or rewrite
history without a new explicit request. Preserve pre-existing changes.

Working tree before this note:

- Modified `.gitignore` (user-owned; preserve).
- Untracked `apps/desktop/scripts/mouse-input-check.html` and
  `apps/desktop/test/mouse-input-check.test.ts` (measurement tooling).
- Untracked `docs/designs/2026-09-29-desktop-review-and-remaining-work.md` and
  `docs/designs/2026-09-29-voice-distortion-investigation.md`.

The independent mouse-input check intentionally suppresses navigation while
measuring events. That is distinct from installation page navigation.

## Verification evidence and environment

Latest navigation/default-delay work: desktop tests 27 passed; desktop
`typecheck` and `build` passed; Rust preference tests 8 passed; Cargo Clippy
`--locked --all-targets -- -D warnings` passed; formatting and diff checks passed.
Earlier combined feature verification: web suite 830 passed, Rust suite 19
passed, root typecheck/build passed. These are historical results for their
respective revisions; run appropriate checks for new changes.
Navigation regressions execute the injected JS in a VM with controlled history
and events. They prove bounded route behavior, not actual Windows peer audio.
User's later successful Windows smoke report supplies separate physical evidence.

This host is macOS. Rust runtime was installed in temporary directories; if
still present, invoke Cargo with:

```sh
RUSTUP_TOOLCHAIN=stable RUSTUP_HOME=/private/tmp/voxly-rustup \
CARGO_HOME=/private/tmp/voxly-cargo \
PATH=/private/tmp/voxly-rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH \
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
```

Pinned-toolchain download can fail if RUSTUP_TOOLCHAIN is omitted. Health/server
fixtures bind loopback and can require sandbox local-listen approval. EPERM is
an environment limit. macOS compilation cannot certify Windows hooks or WebView2.
Native changes require rebuilding/installing the Windows shell; web changes
require updating the installation web deployment. Match English/Turkish copy.

## Continuation completed on 2026-09-30

Call-aware transitions are implemented in ADR-0022 and verified as recorded in
the Windows acceptance document; installed transport/media cases remain open.
Running notification activation is now implemented in ADR-0024: a separate
exact-origin/generation-scoped parameterless command reveals its own window,
then the web document routes to its captured channel without joining voice.
Disposed/replaced alerts and Account changes invalidate handlers. No targets,
message text or credentials enter native state or OS notification content.

Root tests pass shared 19, server 397, web 839, bot 277 and desktop 40; native
tests pass 25. Root typecheck/build, desktop build, affected web typecheck/build,
native Clippy/format, a macOS debug executable and diff hygiene pass. These are
development checks, not installed Windows notification/capture acceptance.

Next implementation slice: external routing-only `Open in desktop` links,
protocol registration and cold/running single-instance forwarding. Consult
`2026-09-30-desktop-activation-research.md`; no deep-link plugin or protocol has
been registered yet. After that, implement the accepted production experience
requirements before signing/distribution. Real updater trust/ownership and
installed Windows process-tree measurements remain release gates.
