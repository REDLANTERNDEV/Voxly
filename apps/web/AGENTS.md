# Web Client Instructions

These instructions apply to `apps/web`. The repository-level `AGENTS.md` also
applies. Files under `src/lib` have additional media and helper guidance in
`src/lib/AGENTS.md`.

## Responsibilities and Structure

The web workspace owns the React application, routing, browser session state,
localized presentation, media UI, and client-side Socket.IO/WebRTC lifecycle.

- `src/App.tsx` is the small application composition root. It wires focused
  controllers together, mounts authenticated runtime audio once, and delegates
  route rendering; do not move feature markup or reusable algorithms into it.
- `src/app` owns route-level contracts plus focused session, workspace,
  realtime, and listener-preference lifecycle controllers. A controller must
  represent one lifecycle concern rather than hide the application in a
  catch-all hook.
- `src/features` owns route and domain surfaces for authentication, chat,
  voice presentation, and owner administration. Feature surfaces receive
  explicit feature props rather than the complete application shell contract.
- `src/components/shell` owns authenticated chrome shared across routes;
  `src/components/ui` owns small reusable presentation primitives and icons.
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
- After an existing user accepts an invite to another server, fetch the complete
  accessible server list and the invited server's rooms before leaving the
  invite surface. Replace the switcher state with that response, preserve the
  user's earlier server options, and open the invited server's first text room
  or first available room.
- Resolve the displayed invite target from the current server name at link-open
  time. Do not embed or retain a stale server name in the invite URL; fall back
  to generic invite copy when preview validation fails.
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
- Derive visible rooms, the current route room, history requests, and fallback
  navigation only from rooms belonging to the active server. A stale room list
  from the previously selected server must render no channel or message while
  the next server loads. Owner-panel navigation returns to that server's
  remembered text room or its first text room, never a hard-coded room ID.
- Unread counts are browser-session state only. Ignore the current user's
  messages, increment only for inactive text rooms, and clear a room when it is
  opened. Do not add persistent read receipts without a separate design.

## Browser Compatibility Gate

- Run browser compatibility gates outside `App` so a blocked environment never
  starts session requests, Socket.IO, WebRTC, or authenticated application
  lifecycle hooks.
- Block only user agents containing the case-insensitive
  `Valve Steam GameOverlay` marker. Do not treat ordinary Chromium user agents
  or `Valve Steam Client` as the Shift+Tab overlay.
- The Steam GameOverlay surface is a non-dismissible full-screen explanation
  with equivalent English and Turkish copy. Direct users to copy the current
  address into a regular Chrome, Edge, Firefox, or Safari browser.

## Member and Owner Surfaces

- The member directory includes active memberships and presents online members
  before offline members. While loading, keep known live/current users visible.
- Directory and nickname updates may replace an existing online presence entry
  but must never add an offline member to the online list. Only authoritative
  presence snapshot/online events may promote a member to online.
- When an online snapshot has not loaded, derive the current user's fallback
  identity from the selected server directory before falling back to the global
  account nickname. Preserve the server-scoped self nickname while realtime is
  disconnected.
- Member-safe directory data is limited to user ID, nickname, and server role.
  Do not reuse owner moderation records as a public directory response.
- The normal server switcher is navigation for owners and members. Server
  creation and deletion belong in the selected owner-server context.
- Reserve the top-left channel-rail lockup for the Voxly mark and application
  name. The active server name belongs in the adjacent server switcher; do not
  repeat it as the rail brand subtitle.
- The selected owner-server context also owns server renaming. Trim and enforce
  the server's 2–64 character contract, update local navigation from the HTTP
  acknowledgement, and apply scoped realtime name updates to the matching
  server summary without disturbing other memberships.
- Owner invites, access links, membership actions, and history operate on that
  selected owner context; do not reintroduce a second invite target selector.
- Invite expiry and maximum uses are independent selects. Show used/limit and
  remaining capacity from server counts; a partially used active invite remains
  revocable, while expired, exhausted, or revoked links are inactive.
- Default invite creation to one day and one use. Offer only the approved
  duration and capacity presets plus an independent unlimited option for each;
  do not recreate a client-side hours contract.
- Newly generated invite and access links are masked in owner surfaces by
  default. An accessible eye control may reveal and hide the complete link;
  copy actions always use the complete one-time value. Masking is presentation
  only and must not place a transformed value into the clipboard or API state.
- Owner and delegated-member invite creation share one composer, so the label,
  expiry, capacity, and masked-link contracts cannot drift between the owner
  dashboard and the rail popover.
- The rail invite affordance appears only when the active server summary reports
  `canInvite`, which is true for owners and for members holding the grant. The
  grant is assigned from member action menus, is offered only by an owner acting
  on an ordinary member, and shows as a distinct role in member surfaces.
- Server and channel deletion keep exact-name confirmation and server-side
  protection against deleting the final owner server or final protected
  channel.
- A local user's row never has an output-volume slider. Remote voice
  participants share one listener-owned volume state across the stage, left
  rail, and right member panel.
- Ordinary members receive personal volume controls only. Disconnect, kick,
  ban, unban, and destructive channel actions remain permission-gated.
- Left-rail voice participants and right-panel directory members reuse the same
  member action menu and confirmation flow. Remote volume remains available to
  listeners; disconnect, kick, ban, and nickname actions appear only when the
  current server role and target member permit them.
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
- Focus and select the nickname input once when the dialog mounts. Keep Escape
  handling in a separate lifecycle so parent or realtime rerenders never reset
  the user's selection, cursor position, or controlled input value.

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
- A message created on the viewer's current local calendar day shows only its
  localized time. Older messages show a localized date containing day, month,
  year, and time; do not compare UTC date strings to decide whether it is today.
- Linkify only valid `http:` and `https:` URLs. Render them as React text and
  anchors with a new browsing context plus `noopener noreferrer`; never inject
  message HTML or turn other protocols into clickable content.
- Rich previews are derived from message links for the explicit YouTube,
  X/Twitter, Vimeo, and Spotify provider allowlist. Deduplicate provider items,
  render at most four previews per message, sandbox provider frames, and leave
  every unknown site as an ordinary link. This is link-preview presentation,
  not a webhook or server-side metadata fetch.
- A preview close action is visible only to the message author or selected
  server owner. Require localized confirmation, keep the original link, and
  apply the server-acknowledged suppression so realtime viewers and later
  history loads agree. Multiple previews are suppressed independently.
- Preserve existing message ownership and moderation permissions in both the UI
  and API handling.

## Context Menus and Layering

- Sidebar rows with actions open the shared portal menu from secondary click or
  ellipsis. Left-rail voice-participant rows are the deliberate exception: omit
  their ellipsis to preserve status-icon symmetry, keep the row focusable, and
  open the same menu with secondary click, the Context Menu key, or Shift+F10.
  Rows without actions retain the browser context menu.
- Compute row action availability from target-specific permissions after all
  filters are applied. Do not render an ellipsis or custom context menu when the
  resulting menu would contain no action.
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
- Owner disconnect, kick, and ban actions use this same shared menu from both
  sidebars. Keep one pending confirmation owner in the application chrome so
  labels, destructive copy, focus behavior, and execution cannot drift between
  the two surfaces.
- Account, audio-device, and stage-volume popovers are not part of the exclusive
  sidebar-menu coordinator.
- Keep audio-device settings in a viewport-clamped portal popover rather than
  expanding the channel rail. Opening the panel must not add another rail or
  page scrollbar; short viewports may scroll inside the popover itself.

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
- Self-managed mute/deafen icons are neutral gray. Owner-enforced mute/deafen
  icons are red and take precedence; owner deafen alone shows only the red
  headset. Keep accessible localized names while remaining visually icon-only.
- Owner voice moderation is available for ordinary members in the owner panel
  regardless of presence and in participant menus while they are in voice.
- Keep the left channel rail visually quiet: text/voice section headings do not
  show room totals, and voice-channel rows do not show participant totals.
  Actual voice participants and text-room unread badges remain visible.
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
- Owner-enforced mute/deafen dock controls are red, disabled, and cannot be
  cleared by the affected member. Self-managed off controls remain gray.
- Show Socket.IO health as signal bars plus the median RTT. After three seconds
  disconnected, make the app inert under the technical reconnect overlay; keep
  it open until the reconnected socket completes a successful probe.
- Probe immediately after connect and every five seconds with one request in
  flight. Use a 2.5-second ACK timeout and the median of the latest five
  successes: up to 150ms is green, 151–300ms yellow, and above 300ms red.
  While disconnected, disable only Socket.IO-dependent voice, join, and LIVE
  actions before the overlay threshold; HTTP-backed surfaces remain usable.
- Reconnect copy remains technical and localized: distinguish browser offline,
  unreachable server, and reconnect attempt. Rotate the existing Voxly mark
  unless reduced motion is requested, and close only after a fresh successful
  probe ACK for the current connection generation.
- Preserve the screen-share monitor/up-arrow geometry and show its diagonal
  cancellation stroke only when the action stops an active share.
- Voice-channel prefixes use the inline microphone icon rather than text such
  as `VC`. The screen-share glyph keeps `currentColor` and an explicit stroke
  weight appropriate to its 256-unit view box so it matches adjacent icons.
- Keep the voice-channel microphone prefix vertically centered with the channel
  name by using an inline-flex container, centered alignment, and a block-level
  icon glyph. Do not compensate with fragile per-icon offsets.
- Add English and Turkish strings together. Test both behavior and accessible
  labels when copy affects an interaction.
- Menus, popovers, dialogs, sliders, and custom controls must remain keyboard
  and touch operable, correctly labeled, focus-managed, and usable with reduced
  motion.
- General input and output levels are listener-account preferences shared across
  that user's servers and clamped to 0–200%. Input gain affects both published
  microphone audio and microphone monitoring. General output composes with
  member and screen-share levels and is clamped before playback.
- Notification cues sit in the audio settings popover below the output level:
  a master switch, then the level and the voice, message, and connection
  switches. Each switch is a labeled `role="switch"` control with its own
  generated label id. The cue level is a separate 0–100% preference and must
  not be presented as part of the general output level.
- Microphone monitoring uses the selected input, follows live input-level
  changes, and stops on panel close or cleanup. While monitoring in voice,
  acquire an acknowledged temporary deafen state, lock the dock deafen action,
  and restore only a state that monitoring itself changed; preserve users who
  were already deafened and never restore across a different room.

## Theme and Contrast

- The neutral dark foundation is Onyx `#0A0A09`; do not restore the former
  brown base through tokens, surfaces, borders, or control states.
- In explicit light mode the left channel rail is white with Onyx foreground.
  In explicit or system dark mode it uses the Onyx background with the shared
  off-white foreground.
- Rail cards, fields, borders, muted copy, member rows, and skeletons use the
  dedicated rail tokens rather than assuming the rail is always dark. Preserve
  readable foreground/background contrast for text, placeholders, icons,
  disabled states, and native selects in both themes.
- A theme change is incomplete if any text becomes indistinguishable from its
  surface. Keep structural CSS tests for the token contract and inspect both
  themes in a browser for geometry- and rendering-sensitive regressions.

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
