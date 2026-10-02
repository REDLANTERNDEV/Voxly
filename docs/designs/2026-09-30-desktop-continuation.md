# Desktop implementation summary — 2026-09-30

This is a historical implementation summary, not an active work queue. Later
notification, deep-link, settings and update work supersedes the original
continuation instructions. Current behavior and release gates live in the
[desktop guide](../desktop.md), [Windows acceptance record](../desktop-windows-acceptance.md)
and applicable [architecture decisions](../adr/).

The contributor confirmed Windows Back/Forward navigation and Push to talk /
Push to mute working. Back/Forward changes only the viewed page and preserves
the active call; Mouse 4/5 retain navigation when assigned voice shortcuts.

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
- Notification preferences are per-Account, with generic English/Turkish copy,
  category/master/deafen gating and silent OS delivery. Existing web cues own
  sound. Current delivery and activation behavior is documented in the desktop
  guide and ADR-0024/0026.

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

## Later implementation

Call-aware shell transitions are implemented in ADR-0022. Running notification
activation is implemented in ADR-0024, and native delivery in ADR-0026.
Browser-to-desktop approval retains Device consent under ADR-0027. Everyday
settings keep native authority local under ADR-0023.

The original lifecycle findings and temporary mouse-input tooling are retired.
Installed media/resource measurements and platform-specific release acceptance
remain recorded in the current Windows matrix. Local macOS builds and automated
regressions do not replace those installed checks.
