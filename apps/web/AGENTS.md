# Web Client Instructions

These instructions apply to `apps/web`. The repository-level `AGENTS.md` also
applies. Files under `src/lib` have additional media and helper guidance in
`src/lib/AGENTS.md`.

## Responsibilities and Structure

The web workspace owns the React application, routing, browser session state,
localized presentation, media UI, and client-side Socket.IO/WebRTC lifecycle.

- `src/App.tsx` composes authenticated surfaces and owns shared application
  state. Avoid making it the home of new reusable algorithms.
- `src/components` contains focused reusable UI surfaces.
- `src/lib` contains pure state helpers and browser integration modules.
- `src/api.ts` is the typed HTTP boundary.
- `src/socket.ts` is the typed Socket.IO client boundary.
- `src/lib/i18n.ts` is the source of English and Turkish UI strings.
- `src/styles.css` is the existing shared visual system.
- `test` uses the Node test runner after TypeScript compilation. Some tests
  intentionally assert source or CSS structure where browser geometry is not
  available.

Use React 19 and existing platform APIs. Do not add a component, menu, styling,
icon, animation, state-management, or media dependency without an explicit
requirement.

## Authentication and Navigation

- Route initial session lookup and successful invite/access/owner claims
  through the authentication request gate. A stale bootstrap response must not
  overwrite a newly authenticated user.
- Treat an authenticated `/invite/:token` route as intent to accept. Share one
  in-flight request per token, auto-accept a valid new membership, and use the
  returned `serverId` for both success and `already_server_member` navigation.
- When an authenticated invite is generically invalid, fall back to the first
  usable accessible server; keep the recoverable invite error surface when no
  active server exists. Never infer the invite's server in the browser.
- Preserve the existing explicit nickname, Turnstile, valid, and invalid invite
  form behavior for unauthenticated users.
- Concurrent access-claim requests for the same token share one Promise and one
  HTTP request. Remove failed requests from the cache so a real retry is
  possible.
- A successful access claim uses the returned `serverId`, refreshes RTC
  configuration, loads server and room state, then leaves `/access/claim`.
  Prefer the first text room, then any room, then the authenticated root.
- Remember last-used text and voice rooms independently per server in versioned
  local storage. Ignore malformed data and fall back when a remembered room no
  longer exists.
- Unread counts are browser-session state only. Ignore the current user's
  messages, increment only for inactive text rooms, and clear a room when it is
  opened. Do not add persistent read receipts without a separate design.

## Member and Owner Surfaces

- The member directory includes active memberships and presents online members
  before offline members. While loading, keep known live/current users visible.
- Member-safe directory data is limited to user ID, nickname, and server role.
  Do not reuse owner moderation records as a public directory response.
- The normal server switcher is navigation for owners and members. Server
  creation and deletion belong in the selected owner-server context.
- Owner invites, access links, membership actions, and history operate on that
  selected owner context; do not reintroduce a second invite target selector.
- Server and channel deletion keep exact-name confirmation and server-side
  protection against deleting the final owner server or final protected
  channel.
- A local user's row never has an output-volume slider. Remote voice
  participants share one listener-owned volume state across the stage, left
  rail, and right member panel.
- Ordinary members receive personal volume controls only. Disconnect, kick,
  ban, unban, and destructive channel actions remain permission-gated.
- Kicked members disappear from the owner member list; banned members remain
  visible so owners can unban them.
- Nicknames are server-scoped presentation. The selected server owner may
  rename ordinary members and their own owner identity, but never another
  owner. Keep the global account nickname unchanged and update directory,
  presence, voice, loaded messages, owner surfaces, and the local account chip
  from the effective server nickname.
- Nickname editing uses the shared accessible dialog, trims input to the
  server-enforced 2–32 character contract, and applies acknowledged HTTP and
  scoped realtime updates without duplicating cached users.

## Chat Interaction Contract

- Enter sends a non-empty draft; Shift+Enter inserts a newline; IME composition
  never sends. The send button uses the same guarded submission path.
- Keep the header and composer stable. The message history is the only vertical
  scroll owner in the text room.
- Auto-scroll appended messages only when the reader is already within the
  near-bottom threshold. Otherwise preserve `scrollTop` and show the localized
  new-message control until the reader returns to the bottom.
- Room changes and initial history load start at the newest message. An edit or
  duplicate realtime delivery is not a new append and must not force scrolling.
- Message actions use the same permission-filtered custom menu from right-click
  and the hover/focus/touch ellipsis. Keep menus viewport-clamped and close them
  on outside input, Escape, or action selection.
- Keep message creation time unchanged after edits. Show the localized edited
  marker beside it and expose the full local edit date and time.
- Preserve existing message ownership and moderation permissions in both the UI
  and API handling.

## Context Menus and Layering

- Sidebar rows with actions open the shared portal menu from secondary click or
  ellipsis. Rows without actions retain the browser context menu.
- Only one sidebar menu may be mounted at a time. Opening another replaces the
  current descriptor before the next overlay renders.
- Outside pointer input, Escape, navigation, drawer changes, and action
  selection close the menu. Escape restores focus to the ellipsis trigger when
  that trigger opened it.
- Keep the ellipsis keyboard- and touch-accessible, visible for coarse pointers,
  and exposed on hover/focus for fine pointers.
- Preserve the 4-pixel gap between a channel surface and its owner-action
  trigger. Long labels must truncate without displacing actions.
- Keep destructive confirmation state with the calling surface. The menu
  closes before its existing dialog opens.
- Owner nickname actions share the same secondary-click/ellipsis menus as
  member volume and moderation actions. Remote volume remains available to all
  listeners; nickname changes remain owner-gated and restore focus after the
  dialog closes when an ellipsis opened the menu.
- Account, audio-device, and stage-volume popovers are not part of the exclusive
  sidebar-menu coordinator.

## LIVE Watch and Voice Presentation

- `LIVE` means screen sharing only; camera alone never shows it.
- The LIVE trigger remains a compact, high-contrast red badge. Its accessible
  hover/focus/touch card opens beside the trigger, is not clipped by the rail,
  and uses no captured or fabricated thumbnail.
- The card stays open across pointer travel using the cancellable grace period
  and closes on focus exit, outside input, Escape, or source removal.
- Watch is one action: if necessary, join or move to the target voice room with
  `microphoneEnabled: true`, subscribe to that user's screen, and focus it on
  the stage. When already in that room, do not rejoin.
- Remote screen sources in the middle source rail reuse this same
  `pendingLiveWatch` path when the viewed room is not the active voice room.
  The complete `visual-source-main` row is the action; do not add a separate
  `Watch` / `İzle` label or a second confirmation step.
- When the middle screen source already belongs to the active voice room,
  subscribe and focus directly. Keep the existing local camera/source
  selection behavior separate and unchanged.
- If the source ends before activation, do not start a join. Surface existing
  localized recovery/error UI when joining or subscribing fails.
- Sidebar voice rows show no icon for an active member, one red muted icon for
  a muted member, and both red deafen and muted icons for a deafened member.
  When both are present, muted is left and deafen is right. Keep accessible
  localized names while remaining visually icon-only.
- Activating a voice-channel name is an entry action, not a browse action. Join
  immediately when disconnected, open the already-active room without a new
  join, and require one localized confirmation before moving from another
  voice room. Navigate only after the acknowledged join succeeds.
- The call surface is the sole voice-room scroll owner. Keep stage, available
  sources, and participants in normal flow in that order; do not add nested
  scrollbars, sticky sections, or absolute positioning.
- Allow the stage to contract on short viewports without covering later
  sections. Fullscreen remains exempt from in-panel height bounds.

## Controls, Icons, and Accessibility

- Functional UI icons are inline React SVG using `currentColor`; do not add an
  asset file for an icon already represented by a component. SVGs remain
  `aria-hidden` when the surrounding control supplies the accessible name.
- Microphone, deafen, camera, and screen-share dock controls use the same 44px
  hit area and 24px glyph on desktop, and the same 40px hit area and 24px glyph
  on mobile.
- Preserve the screen-share monitor/up-arrow geometry and show its diagonal
  cancellation stroke only when the action stops an active share.
- Voice-channel prefixes use the inline microphone icon rather than text such
  as `VC`. The screen-share glyph keeps `currentColor` and an explicit stroke
  weight appropriate to its 256-unit view box so it matches adjacent icons.
- Add English and Turkish strings together. Test both behavior and accessible
  labels when copy affects an interaction.
- Menus, popovers, dialogs, sliders, and custom controls must remain keyboard
  and touch operable, correctly labeled, focus-managed, and usable with reduced
  motion.

## Web Verification

Use focused compiled tests while iterating when possible. Before handing off a
web behavior change, run:

```sh
npm run test -w @voxly/web
npm run typecheck -w @voxly/web
npm run build -w @voxly/web
```

For styling or interaction changes, also inspect desktop, short-viewport, and
narrow/coarse-pointer behavior when a browser is available. Structural source
tests complement that check; they do not replace it for geometry-sensitive UI.
