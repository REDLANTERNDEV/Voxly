# Monochrome Interface Refactor Plan

**Status:** implemented

## Goal

Refactor Voxly's authenticated workspace, account flows, and owner tools into a
dark-first monochrome system based on the four provided references: blue-black
and graphite surfaces, silver controls, compact geometry, restrained borders,
and typography-led hierarchy. Keep the existing landing composition restrained.
Remove teal and blue from ordinary navigation, buttons, selected rows, focus
treatment, and decorative surfaces without changing product behavior.

"Monochrome" applies to product chrome, not to information that relies on
colour. Danger and owner-enforced states remain red; online, idle, connection,
and warning states retain distinct accessible status colours; member avatars,
camera video, screen shares, album art, and External previews remain natural
media. Every state must also remain understandable from text, shape, icon, or
position rather than colour alone.

This is a targeted redesign using the existing React, inline SVG, and CSS stack.
It does not introduce a component library, animation library, styling framework,
icon package, or new runtime dependency.

## Reference reading

The references describe one coherent system rather than four separate pages:

- near-black canvas with graphite panels and cool silver borders;
- white or silver primary actions instead of a branded colour fill;
- compact controls with small radii and strong pressed, focus, and disabled
  states;
- dense application surfaces separated by dividers and tonal steps instead of
  large shadows;
- larger, heavier display type only where a route needs an introduction;
- red, green, and amber used sparingly for destructive actions and live status;
- the same component vocabulary across chat, voice, owner tools, settings,
  empty states, permissions, notifications, and authentication.

The screen compositions are references, not new feature requirements. Voxly's
existing route structure, Server and room terminology, authorization, member
states, focus behavior, responsive drawers, voice ordering, and media behavior
remain authoritative.

## Current-state audit

### What is already strong

- The web client already has reusable button, icon-button, field, dialog,
  notification, status, navigation, and empty-state classes.
- The application uses semantic tokens for most surfaces and states.
- Hover, pressed, disabled, focus-visible, reduced-motion, narrow-layout, and
  coarse-pointer behavior already exist and should be refined rather than
  replaced.
- The current system uses SF Pro-family platform stacks rather than a generic
  bundled web font. A font dependency is not needed for this refactor.
- The shell, chat, voice, owner, settings, and authentication surfaces are
  already separated into focused React components.

### Problems to resolve

1. **Three competing CSS layers.** `styles.css`, `visual-refresh.css`, and
   `workspace-refresh.css` each define visual decisions. The final workspace
   layer replaces the shared palette with teal, while the earlier refresh layer
   hardcodes blue. Selector order, rather than a single token contract, decides
   the final theme.
2. **Multiple ordinary accents.** Teal, blue, and several direct colour literals
   appear in active navigation, primary actions, selected rows, focus rings,
   preview decoration, and voice presentation. These uses conflict with a
   monochrome interface and make semantic colours feel less meaningful.
3. **Tests preserve the outgoing palette.** The current theme test explicitly
   requires blue accent tokens. It must be changed alongside the token contract,
   not after the visual work.
4. **Selected and focused states lean on hue.** Several controls communicate
   selection with an accent border, fill, or inset line. The replacement needs
   a consistent silver contrast step plus a visible focus ring that works in
   both themes.
5. **Surface hierarchy is uneven.** Some areas use divider-led continuous
   surfaces while others use bordered cards, gradients, or shadows for the same
   hierarchy level. The references use borders for structure and reserve
   elevation for menus, dialogs, and notifications.
6. **The public and authenticated products drift.** Public and authentication
   routes currently use a blue action system while the authenticated workspace
   uses teal. They should share control primitives even when their layouts are
   different.
7. **The current refresh files contain overlapping generations of rules.** A
   second interface-system block in `visual-refresh.css` overrides earlier
   declarations in the same file. Extending this pattern would make the next
   visual change harder to reason about.

## Design system decision

### Palette

Use a cool neutral scale with no decorative hue:

| Role              | Dark direction                   | Light direction                |
| ----------------- | -------------------------------- | ------------------------------ |
| Canvas            | blue-black near `#0b0d10`        | cool off-white near `#f4f5f6`  |
| Raised surface    | graphite near `#111317`          | white                          |
| Secondary surface | cool charcoal near `#181c22`     | cool gray near `#eaedf0`       |
| Strong control    | silver/off-white                 | graphite                       |
| Primary text      | off-white                        | blue-black                     |
| Secondary text    | cool gray                        | slate                          |
| Border            | low-contrast cool gray           | pale slate                     |
| Focus             | high-contrast silver double ring | graphite double ring           |
| Selected          | one tonal step plus inset edge   | one tonal step plus inset edge |

Keep semantic tokens separate from the neutral scale:

- danger and owner enforcement: red;
- online, connected, success, and speaking: green where the existing contract
  requires state distinction;
- idle, degraded quality, and warning: amber;
- offline, disabled, and self-managed mute/deafen: neutral gray;
- `LIVE`: the existing compact high-contrast red treatment;
- media, avatars, artwork, and Provider content: unchanged.

Do not alias success to the ordinary accent. A successful state and a selected
control answer different questions.

### Typography

Keep the existing platform font stacks for this pass. Refine their use instead:

- 600–700 weights for route titles and primary control labels;
- 500–600 for navigation, member names, table headers, and field labels;
- tabular figures for RTT, times, Queue durations, counts, limits, and Link or
  Recovery codes;
- tighter tracking on display headings and calmer sentence-case labels;
- balanced wrapping on landing/auth headings and readable line lengths on
  explanatory copy.

### Geometry and depth

- Use 6–8px radii for fields, compact controls, rows, and inner panels.
- Use 10–12px radii only for dialogs and major route containers.
- Prefer dividers and one-step tonal changes over nested card borders.
- Reserve substantial shadows for menus, popovers, dialogs, notifications, and
  the landing product preview.
- Keep existing 44px desktop and 40px mobile voice-control hit areas.
- Use transform and opacity for motion, with reduced-motion fallbacks.

## Component treatment

### Buttons and icon controls

- Primary: silver/off-white fill with dark text in dark mode; graphite fill with
  light text in light mode.
- Secondary: transparent or secondary-surface fill with a restrained border.
- Tertiary: text or icon-only treatment for low-priority actions.
- Destructive: retain red, but avoid red on unrelated dismiss or mute actions.
- Pressed: one-pixel translation or subtle scale plus a darker tonal step.
- Focus: neutral high-contrast ring independent of selected state.
- Loading and disabled states preserve label width and do not rely on opacity
  alone.

### Fields, selects, switches, sliders, and tabs

- Fields use a dark inset surface, one-pixel neutral border, brighter hover, and
  neutral focus edge.
- Native selects retain readable option colours in explicit and automatic dark
  modes.
- Switches use neutral track contrast; semantic colour appears only when the
  switch represents a semantic state.
- Slider fill is silver for ordinary volume; warning/danger appears only in a
  genuinely warning/danger state.
- Selected tabs use a brighter surface and bottom or inset edge, not teal.

### Navigation, rows, badges, and presence

- Active workspace, Server, room, owner-section, and settings rows share the
  same selected treatment.
- Hover and unread states remain distinguishable from selected state.
- Member and room rows stay compact and quiet; existing counts and status-icon
  rules remain unchanged.
- Role badges become neutral outlined labels. Bot, owner, moderator, and Invite
  grant wording remains visible and accessible.
- Presence dots retain semantic colour and accessible names.

### Panels, tables, dialogs, menus, and notifications

- Route structure uses continuous surfaces and dividers.
- Cards appear only for a real grouping, elevation, or warning boundary.
- Tables use tonal headers, stable column alignment, tabular figures, and a
  quiet hover row.
- Dialogs and menus use the same surface/border/shadow recipe and keep current
  focus-management and layering contracts.
- Notifications use a neutral surface with a narrow semantic edge or icon; the
  entire card should not become a saturated colour block.

### Chat, voice, and Music

- Message rows remain borderless and gain only a subtle neutral hover surface.
- Composer, reply strip, pending/failure actions, and External preview frames
  adopt the shared neutral primitives.
- Stage selection uses a silver edge; video and screen content remain untouched.
- Speaking keeps its transitioned semantic ring as required by the voice
  presentation contract.
- Self mute/deafen stays neutral; owner enforcement stays red.
- Queue current-row and offered-Result treatments use words plus a neutral
  selected surface, preserving their existing accessible labels.
- Keep stage, available sources, participants, Music, and Set log in their
  required order and keep the call surface as the only scroll owner.

### Landing, authentication, settings, and owner tools

- Landing keeps its asymmetric text/product-preview composition but replaces
  the blue CTA and decorative blue highlights with silver and graphite.
- Authentication routes use the same primary action and field treatments as
  the application.
- Settings and owner navigation share the workspace selection model.
- Permission, empty, loading, recovery, connection, and destructive states use
  the component system rather than route-specific colour blocks.

## Implementation sequence

Each phase should be a reviewable slice. Do not combine a layout rewrite with
the palette change.

### Phase 1 — establish the token contract

1. Inventory direct colour literals and classify each as neutral, semantic, or
   media-only.
2. Define one neutral palette and one semantic palette for explicit light,
   explicit dark, and automatic dark mode.
3. Replace the blue/teal theme test with assertions for neutral ordinary
   controls and independent semantic tokens.
4. Stop redefining the authenticated palette inside `.authenticated-surface`.
5. Consolidate the overlapping refresh rules so import order no longer defines
   the theme. Keep `styles.css` as the geometry/behavior owner and
   `visual-refresh.css` as the sole palette and presentation layer.

### Phase 2 — migrate shared primitives

Update buttons, icon buttons, fields, textareas, selects, switches, sliders,
tabs, labels, focus rings, skeletons, status pills, menus, dialogs, empty states,
and notifications. Validate every interactive state in light and dark mode
before moving to feature surfaces.

### Phase 3 — migrate application chrome and chat

Update the workspace rail, channel rail, member panel, room header, message
rows, composer, context menus, Invite popover, account menu, and dock. Preserve
drawer behavior, the existing breakpoints, coarse-pointer access, and the
exclusive sidebar-menu coordinator.

### Phase 4 — migrate voice and Music

Update stage/source selection, participant rows, dock controls, volume popovers,
Music controls, Queue, Results, and Set log. Verify semantic voice states before
removing any remaining accent literal.

### Phase 5 — migrate owner, settings, and account entry routes

Update owner navigation, stat summaries, tables, forms, settings, account and
Device cards, Link and Recovery screens, Invite claim, and browser
compatibility. Keep the landing layout and copy in place, and keep English and
Turkish presentation behavior equivalent.

### Phase 6 — responsive and state polish

Audit desktop, short desktop, tablet/drawer, small phone, coarse pointer,
keyboard-only, reduced motion, explicit light, explicit dark, and automatic
theme. Resolve isolated hardcoded colours only after checking whether each one
is semantic or belongs to media.

## Expected file scope

Primary styling work:

- `apps/web/src/styles.css`
- `apps/web/src/visual-refresh.css`
- `apps/web/test/theme-contrast.test.ts`

Small markup or class changes may be needed in:

- `apps/web/src/components/ui/Primitives.tsx`
- `apps/web/src/components/ui/Dialogs.tsx`
- `apps/web/src/components/ui/Notifications.tsx`
- `apps/web/src/components/shell/*`
- `apps/web/src/features/auth/*`
- `apps/web/src/features/chat/*`
- `apps/web/src/features/voice/*`
- `apps/web/src/features/owner/*`

Markup changes should be limited to semantic grouping, reusable state classes,
and missing accessible state. No controller, API, Socket.IO, WebRTC, or shared
contract change is expected.

## Acceptance criteria

- Ordinary buttons, active rows, focus rings, tabs, and decorative elements use
  no teal or blue in either theme.
- Semantic red, green, and amber appear only where their state meaning is clear.
- The authenticated workspace and public/auth routes share the same primitive
  control language.
- Explicit dark and automatic dark tokens remain identical.
- Light mode remains readable and intentionally designed rather than receiving
  inverted dark values.
- Selected, hovered, focused, unread, disabled, loading, danger, success,
  warning, online, idle, offline, self-muted, owner-muted, and LIVE states remain
  visually distinct without depending on colour alone.
- Existing keyboard, touch, focus restoration, reduced-motion, drawer,
  breakpoint, and scroll-owner contracts continue to hold.
- English and Turkish copy remains behaviorally equivalent.
- No new dependency is added and no feature behavior changes.

## Verification

For every implementation phase:

```sh
npm run test -w @voxly/web
npm run typecheck -w @voxly/web
npm run build -w @voxly/web
git diff --check
```

Browser QA must cover the landing page, Invite and Recovery entry points, text
room, voice room with and without screen share, Music Queue, member panel,
owner tables and destructive dialogs, settings, notifications, loading/empty/
error states, and reconnect overlay at the repository's 1180px, 900px, and
560px layout boundaries.

## Out of scope

- Feature additions shown only in the references.
- A framework, component-library, icon-library, or font migration.
- Changes to authorization, persistence, realtime, media, or product terms.
- Removing light mode.
- Making avatars, shared media, album art, or External previews monochrome.
- Replacing accessible semantic state colours with indistinguishable gray.
