# Invite card and one Account per person

Decision record: [ADR-0036](../adr/0036-an-invite-joins-the-account-you-already-have.md).

## Problem

**Duplicate Accounts.** Testers end up with two Accounts. The usual cause is
an Invite clicked inside the desktop app:

1. Chat links render with `target="_blank"`.
2. The desktop shell sends every new window to the OS default browser
   (`apps/desktop/src-tauri/src/platform.rs`, `on_new_window`).
3. That browser has no session, and `POST /api/invites/accept` runs
   `existingUser ?? createUser(...)`, which creates a second Account.

**A confusing invite page.** It shows an editable "Invite code" field,
pre-filled with the token, even when the visitor arrived by clicking a link,
and a nickname field beside it. People do not know which box matters.

**No way to paste an Invite once signed in.** A member who is already inside
Voxly has nowhere to paste an Invite they were sent.

## Stories

1. **Already has an Account.** Ayşe uses the desktop app. A friend sends her an
   Invite on WhatsApp and it opens in Edge. She presses Join and picks "I already
   have an account". Edge shows a box for a Link code. She opens Link device in
   the desktop app, types the code into Edge, sees the same confirmation number on
   both Devices, and approves. Edge lands in the new Server as Ayşe. She still has
   one Account and one set of Memberships.
2. **Link clicked in chat.** Mehmet clicks an Invite posted in a channel he is
   in. The invite card opens in the same window, already signed in, and he
   presses Join. No browser opens.
3. **New to Voxly.** Can opens his first Invite. He sees the card, presses Join,
   picks "New to Voxly", types a nickname and is in.
4. **Pasting an Invite.** Elif is sent a bare invite token. She presses **+** at
   the end of the server list, pastes it, sees the card and presses Join.
5. **Another Installation.** Elif pastes a link from a different Voxly address.
   The dialog says it belongs to another Voxly at that host and does not
   pretend it can join it.

## The invite card

The card sits inside the account-entry frame:

- the Server's letter mark (the rail's code-point-safe first letter; Servers
  have no logo);
- its current name;
- `N members · M online`;
- expiry and remaining uses (existing copy);
- one **Join** button.

There is no token field when the card was opened from a link. The token lives
only in component memory, and the address bar is scrubbed to `/invite` as
today.

| Visitor                     | Join does                                                    |
| --------------------------- | ------------------------------------------------------------ |
| Signed in                   | Accepts. Success or `already_server_member` opens the Server |
| No session                  | Opens the fork below                                         |
| Invalid / expired / used up | No card: the generic "ask the owner" state, no counts        |

The fork has two equal choices:

- **New to Voxly** → nickname, Turnstile when configured, then accept (201 plus
  session cookie, unchanged).
- **I already have an account** → the Link code claim, embedded in the card →
  pending, with the confirmation number → approved. Then accept, now with a
  session, and a full reload into the returned `serverId`. The reload is needed
  because startup resolved this page as signed out.
  - **I don't have my other device** sits under this choice, quieter. It opens
    the Recovery code redeem, with the sign-out-everywhere cost stated first.
    On success it accepts and reloads the same way.

`/invite` with no token keeps one paste field. It is the only token field left
on the page.

## The app is offered to people who have an Account

Most members (about ten in fifteen) use Voxly in a browser and have no app, so
Join never tries one and nobody waits. On a Windows browser with no session:

1. Join asks "Have you used Voxly before?" at once.
2. "Yes, I have an account" shows **Open in the Voxly app** first, then the
   Link code. As this screen opens, the card prepares a hand-off
   (`POST /api/invite-launches`): a public id for this Invite, good for ten
   minutes and one join.
3. The button opens `voxly://open?origin=…&launch=<id>`. The app opens the card
   for that id (`/invite#launch=<id>`), signed in as its own Account, and
   reading it marks the hand-off opened.
4. The browser polls `GET /api/invite-launches/:id`. "Opened" shows "Opened in
   the Voxly app ✓ — Press Join server there", with "Continue in this browser
   instead" beneath.
5. With no answer after five seconds the card says the app did not open and
   points to the code. A later answer still switches to "opened".

Chrome and Edge ask "Open Voxly?" the first time, with an "always allow" box;
that prompt is theirs. Telephones and other systems show only the Link code,
because the desktop app is Windows-only.

## Counts

`POST /api/invites/preview` adds `memberCount` and `onlineCount` on the valid
path only.

- **Members** are active Memberships of human Accounts. Bots, banned or removed
  Memberships, globally banned Accounts and Deleted accounts are excluded.
- **Online** is the subset with a live connection whose Status is not
  Invisible.

Every invalid path keeps the generic `404 invite_invalid`.

## Invite links clicked inside Voxly

A plain left click on a link resolves through one parser,
`parseInviteInput(value, installationOrigins)`. The Installation's origins are
the page origin and the configured public URL. If the link names this
Installation's `/invite#<token>` or `/invite/<token>`, the click navigates in
place to the invite card. Ctrl, Cmd and middle clicks keep native behaviour.
Because the page is never reloaded and nothing opens a new window, the desktop
needs no change.

## The + dialog

A **+** sits after the last server in the workspace rail. It is shown to every
member and labelled "Join a server". It opens a modal with one field. The same
parser decides what was pasted:

- **This Installation** (either link shape, or a bare token) → the same card,
  inline → Join → the Server opens.
- **Another Installation** → "This invite is for another Voxly at `host`". In a
  browser, **Open** opens it in a new tab. In the desktop app, the dialog shows
  the address with Copy and points to adding it from the Voxly home.
- **Not an Invite**, or one the server rejects generically → one error line.

The **+** only joins. Creating a Server stays where it is.

## Slices

1. Server: counts on the preview, plus a shared `InvitePreview` type.
2. Web: the invite card and the fork, with Link and Recovery extracted into
   embeddable parts, and one in-flight accept per token.
3. Web: same-Installation invite links open in place.
4. Web: the **+** dialog.
5. "Yes, I have an account" offers the desktop app: a hand-off row, a
   `voxly://` launch carrying its public id, the app opening the card, and the
   browser learning from the server that it opened.

## Ruled out

- Merging, refusing or detecting duplicate Accounts on the server.
- Fingerprinting by IP or device.
- Claiming https links for the desktop app. That needs a per-domain binding at
  build time, which per-operator domains and NSIS rule out.
- An Invite token in a `voxly://` URI.
- QR sign-in of the browser from a signed-in phone, which is QR-login phishing
  waiting to happen (ADR-0021).
- Guessing that the app opened from the page losing focus.
- Server logos, which are a separate feature.
- Auto-accepting for a signed-in visitor. The card is shown and Join is pressed
  once.
