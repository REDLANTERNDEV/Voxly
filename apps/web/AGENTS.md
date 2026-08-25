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
- A room that closes the microphone overrides the join default as well as an
  explicit request, and the toggle refuses while the member is in it — the same
  guard owner mute uses. Show the control locked; an enabled control the server
  will not honour reads as a bug.
- Idle marks a member; it never moves them. The browser sees input only inside
  its own window, so a muted player in a fullscreen game and someone who walked
  away produce the identical signal, and no threshold separates them. The costs
  of confusing them are not symmetric: failing to flag an absent member leaves a
  stale name in a list, while acting on a present one pulls them out of the
  conversation and mutes them, in a window they are not looking at. A dot is the
  only consequence that guess earns.
- Moving a member between voice rooms is an owner action, taken deliberately,
  and it reaches the target as an instruction rather than a state change: the
  client owns the peer connections, so it carries the move out through the same
  join it would have performed itself.
- Idle is measured in the browser, never from socket liveness: a tab that is
  open, connected, and untouched is exactly the case AFK exists for, and the
  server cannot tell that apart from someone listening. Speaking counts as
  presence.
- The idle window is the owner's setting for the server whose voice room the
  member occupies, not the one they happen to be looking at — voice outlives
  navigation.
- Away status is reported independently of the move: the directory dot applies
  to a member with no voice room to be moved out of. Send transitions only; the
  socket is not a heartbeat.
- Presence is three states in the member panel — online, idle, offline — each
  with its own colour and an accessible name. Offline is the absence of a
  presence entry, so a status update may only modify a member already listed.
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
- Member-safe directory data is limited to user ID, nickname, server role, the
  invite grant, and whether the account is a Bot. Do not reuse owner moderation
  records as a public directory response.
- A Bot is listed with the members it sits among, marked with a visible text
  badge and a title that says what it is — not an icon alone, which reads as
  decoration next to a nickname. It is named a Bot in the role line rather than
  a user, and it carries no second role tag.
- A Bot is left out of every member count, anywhere one is shown, while staying
  in the list itself. It is always present and never joined, so counting it
  inflates the one number a member reads as "how busy is it". A new surface that
  counts members inherits this rule; the count is over people, the list is not.
- Offer a Bot the voice actions it can be the subject of — mute, deafen and
  disconnect — and withhold the ones that presuppose a person: kick, ban, invite
  grant, access link **and a move**. Do it in every surface that presents them:
  both sidebars and the owner panel. The server refuses all five for a Bot, so
  offering them would be a menu of guaranteed errors — and the client hiding them
  is presentation, never the enforcement.
- A move is the one that reads like it belongs on the other list, so gate it on
  `canOwnerModeratePerson` rather than on the voice answer beside it. The bot is
  summoned into a room by somebody in it and never pushed sideways; ADR-0010
  records what each half of a move would otherwise do. Mute and disconnect are
  honoured by the bot process itself (ADR-0009).
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
- Submission never waits on the network. The draft clears immediately, the
  composer and send button stay enabled, and an in-flight message must not gate
  the next Enter; a gated composer discards keystrokes instead of queueing them.
- An unacknowledged message renders from the room outbox, not from history. It
  carries a local id so it can never collide with the `message:new` broadcast
  the author receives for their own write, and it is replaced by the server copy
  on acknowledgement.
- Deliveries are serial per room so composed order survives a slow link. A
  failure marks that message alone; it stays visible with localized retry and
  discard actions rather than disappearing or blocking the composer.
- An unsent message has no server id, so it offers no edit, delete, link, or
  rich-preview affordance.
- Reply is available to every reader, from the hover control beside the ellipsis
  and from the same permission-filtered menu. Edit and delete stay gated.
- A reply renders its quote from `replyToMessageId`, not from `replyTo`. A
  target that has been deleted keeps the strip and says so; silently demoting
  the message to an ordinary one loses the fact that it was an answer.
- The quote is one clipped line and never wraps. Starting a reply focuses the
  composer; Escape and the strip's own control both cancel it.
- Jumping to a quoted message marks the destination as well as scrolling to it,
  and any selector built from a message id is escaped.

## Idle and the AFK Room

- Idle is measured in the browser, not from socket liveness. A tab that is open,
  connected, and completely untouched is the case the feature exists for, and
  the server cannot tell that apart from someone listening.
- Pointer, keyboard, wheel, and touch interaction all count as presence, and so
  does speaking: someone who talks for two hours without touching the mouse is
  the opposite of away. Listen in the capture phase so a handler that stops
  propagation cannot make a present person look absent.
- Only a member already in voice is moved. Idling in a text channel is not a
  state the AFK room can express, and joining voice on someone's behalf is an
  action they never asked for.
- Resolve the AFK room from the server whose voice room the member is connected
  to, through the cross-server index rather than the active server's room list.
  Voice outlives navigation here, so the active list is empty for anyone
  browsing elsewhere while connected.
- A server with no AFK room parks nobody; do not fall back to another room. The
  index is rebuilt from each full room list so a deleted AFK room leaves no id
  behind to aim at.
- The move is an ordinary voice join through the direct path, not the
  gesture-gated wrapper: an idle move has no user gesture to unlock output with,
  and the session is already playing audio. A failed move must not retry every
  tick.
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

- `LIVE` means screen sharing only; camera alone never shows it. A live camera
  gets its own neutral rail status icon instead, beside mute and deafen.
- Speaking is shown as a ring on the avatar, in the rail and on the call
  surface alike, and never as a status chip. It changes several times a
  sentence, so a chip appearing and disappearing at that rate reads as flicker
  and a filled row arrives too abruptly to follow. Transition the ring.
- Fullscreen removes the stage panel border. With no page behind it, that border
  reads as a coloured line drawn around the video.
- Rail status icons cover both moderation and media. Owner-enforced deafen
  replaces the self mute and deafen icons, but not the camera icon: a camera is
  a media fact rather than a moderation state.
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
  sources, participants, and music in normal flow in that order; do not add
  nested scrollbars, sticky sections, or absolute positioning.
- Music comes **after** the participants, not before them. The panel used to
  precede them, when it was two controls and a status line; it now carries the
  Queue, and a list that grows with every paste sitting above the roster pushes
  the people in the room off the screen. The design and ticket 08 both place it
  after the participant list.
- The Queue grows the panel and the panel grows the page. A scroll region inside
  it would also make it a fixed-height block the stage has to shrink for, which
  is the one thing adding music must not do to somebody who was already sharing
  a screen. The same holds for a search's Results: bound the *count* — five, at
  `musicSearchResultsMax` — rather than reaching for a height.
- Allow the stage to contract on short viewports without covering later
  sections. Fullscreen remains exempt from in-panel height bounds.
- The Music panel is shown only when the viewed room is the active voice room.
  Being in the channel is what entitles a member to summon, the server enforces
  that, and a control that could only ever be refused is worse than no control.
- Read whether the music is playing from the published Queue
  (`MusicQueueState.playing`), never from local state left over from a press and
  never from the bot's `speaking` flag on the voice snapshot. Both were answers
  to the same question and they disagree — the server clamps `speaking` off for
  a bot an owner has muted, while the Queue goes on playing, and the two arrive
  in separate messages. ADR-0006 records the choice; the practical part is that
  the buttons, the rows and the Queue all come out of one message, so nothing in
  the panel can contradict anything else in it. ADR-0009 retired one of the
  reasons — a mute really does silence the bot now — and left the choice
  standing on the rest.
- An owner's mute stays visible as the panel's resting sentence, not as the
  polarity of a button — and only while the Queue is playing. That is the one
  state where it explains anything: the Queue says a Track is running and the
  room hears nothing. Over a paused or empty Queue the silence needs no
  explaining. The sentence **reports** rather than instructs — the bot enforces
  its own silence (ADR-0009), so it no longer asks anyone to press Pause to
  finish the job — and the button keeps offering Pause, because a Queue nobody
  can hear is still a Queue a member may want to stop.
- Transport controls name the entry they act on. Skip carries the `entryId` the
  panel believes is playing and Remove carries the row's own — never a position
  — so a panel one message out of date skips nothing rather than skipping the
  Track that moved up into place.
- Disable the transport controls when nothing is queued. A visible, enabled
  control that does nothing is indistinguishable from a broken one.
- Play and Pause are one button whose label says which half it is, with no
  pressed state announced beside it: "Pause, pressed" leaves a listener working
  out the one thing the label has already told them.
- An icon-only control in a Queue row carries the Track's name in its accessible
  label, and a short `title` beside it, as the chat row controls do. A column of
  buttons all called "Remove" tells a screen-reader user nothing about which
  Track they are about to lose.
- A control that can take away the thing it acts on must catch the keyboard when
  it does. Skipping the last Track disables the button under the cursor and
  removing a row unmounts it; the browser then drops focus to the document and
  leaves a keyboard user at the top of the page. Restore it only for the
  member's *own* press — the Queue also changes when somebody else acts, and
  pulling focus for that is worse than losing it.
- Render the Queue from what the bot published to the room (`music:queue`),
  never from a Track remembered out of an acknowledgement. The acknowledgement
  reaches the one member who asked; the Queue is what the other four are owed.
- Resolve each Requester's nickname here, from the room's members. The bot
  publishes ids on purpose — see ADR-0005 — and a Requester who has left is
  named by a stand-in sentence rather than by an id nobody can read.
- Show no Queue when no bot is in the room. The bot owns it, and a list left
  over from a Set that ended is a list of Tracks nobody is going to hear.
- Tell the playing Track apart by words as well as by styling. "Now playing" is
  a row anyone can read; a differently shaded background is not.
- Every refusal from `music:control` gets its own localized sentence. The whole
  output of this control is sound in someone else's headphones, so "nothing
  happened" is the one answer it cannot give.
- **The Set log is the room's, and it arrives inside the published Queue.**
  Read it with `musicSetLogRows` exactly as the entries are read with
  `musicQueueRows`, resolve each member's nickname here for the same reason the
  Requester's is resolved here, and name a member who has left with the same
  stand-in. Do not mistake it for the exception below: everyone in the channel
  must read the same explanation for the same silence, or a line answers one
  member's question and not the other four's. ADR-0008.
- **The Set log goes last, below the transport controls.** Everything in this
  panel grows the page, but the Queue grows only when somebody adds while the
  log grows on every press anyone makes — including a pause that changes nothing
  else here. Anything above it drifts down under a member reaching for it, so
  the part that grows goes last and every control's position stays a function of
  the Queue alone. Bound the count at the wire (`musicSetLogMaxLines`), never
  with a height: the scroll-owner rule applies to it as it does to the Queue and
  to a search's Results.
- **The log is not a second live region.** This panel has one and it belongs to
  the member waiting for an answer to their own press; announcing every other
  member's action over the top of it would talk across that answer. Key each
  line by its `lineId` — two members pausing in turn produce two sentences that
  read identically.
- **One translation string per verb, carrying the whole sentence.** Turkish does
  not put these words in English's order, so a line assembled out of fragments
  in JSX would have to be reassembled per language. The five verbs must also
  read differently from one another in both languages; a log whose verbs read
  alike explains nothing.
- **A search's Results are the one thing in this panel that is not the room's.**
  Everything above is "read it from the published Queue"; this is the exception
  and ADR-0007 is why. They arrive on the asking member's own acknowledgement,
  they live in `useState` inside `MusicPanel`, and nothing merges them into
  `queues` or sends them anywhere. Do not move them into the room's state
  because the rule above says state comes from the room — that rule is about
  what five people must agree on, and a list one member is still choosing from
  is not that.
- One field and one submit take a name and a link alike. The browser does not
  inspect the string — which of the two it is is the bot's answer (ADR-0007) —
  so there is no second control, no second verb, and no URL input mode on a
  field that takes words as often as a link.
- A successful acknowledgement now has two shapes. Branch on `kind` rather than
  reading `track` and hoping; a Track was queued, or the bot is asking which of
  several was meant.
- The closest Result is offered first and takes the keyboard, so a member who
  pressed Enter to search presses Enter again for the obvious answer. Tab
  reaches the rest, Escape puts the list away and gives the field back — from
  anywhere in the panel, because a member goes back to the field to ask a
  different question — and typing in the field clears an answer that is being
  replaced, the sentence in the live region along with the list.
- **Mark the Result on offer in the row, not by leaving it to the focus ring.**
  Focus does move to it, but a member who submitted with the pointer gets that
  focus moved programmatically and browsers deliberately draw no ring for that;
  the "already selected" the design asks for would be invisible to exactly the
  people who did not use the keyboard. A border and its own line of text, as the
  playing Queue row already has, and in its accessible name too.
- A Result's control is the whole row and carries the Track in its accessible
  name — title, length and channel — for the same reason a Queue row's Remove
  does. The length is what catches an hour-long mix and the channel is what
  catches a cover, which is the entire reason a list is shown rather than the
  first hit being queued.
- Choosing a Result sends back the link the bot built, unread, on the same `add`
  a paste uses. Never construct a source's URL here.

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
