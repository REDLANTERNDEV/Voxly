# Owner, startup, stream, and account-entry checks

Start the disposable fixture server with `npm run dev:ux-check -w @voxly/web`.
The fixtures do not connect to a real Account, open a microphone, or capture a
screen. The screen source is drawn into a canvas; its audio track is silent.

`implementation-check.mjs` exports checks for a documented CUA browser `tab`
and `viewport` capability:

- `checkStreamHierarchy(tab)` checks automatic Watch join, fullscreen video
  retreat, Escape, volume controls, return to box, source removal, and failed
  join recovery. It asserts actual subscriptions displayed by the fixture.
- `checkAccountEntry(tab, viewport)` checks invite, owner/access claims, Device
  linking, recovery, and desktop approval in English and Turkish at 390 and
  1280 pixels. It checks overflow and the single shared header, and returns
  named screenshot bytes for visual review. It resets the viewport afterward.

Account fixtures are at `/implementation.html?screen=invite` (also
`owner-claim`, `access-claim`, `link`, `recover`, `approval`). Use `lang=tr`,
`theme=light`, or `state=loading` for variants. Invites and submitted codes
are synthetic and refused; no authentication tokens are issued.

The actual installed Windows desktop still needs refresh and fullscreen
acceptance checks. Browser fixtures cannot establish native-window behavior.
