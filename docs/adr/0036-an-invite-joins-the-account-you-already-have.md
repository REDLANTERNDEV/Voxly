# ADR-0036 — An Invite joins the Account you already have

- **Status:** accepted
- **Date:** 2026-11-04
- **Context:** extends [ADR-0014](0014-members-link-their-own-devices.md); builds on
  [ADR-0027](0027-browser-desktop-handoff-keeps-approval.md)

## Context

ADR-0014 named the gap and closed only half of it. Redeeming an Invite on a
Device with no session runs `existingUser ?? createUser(...)`, so a person who
already has an Account on this Installation becomes a second person. ADR-0014
gave members Link and Recovery, but nothing on the invite page leads to them.

Testers keep producing duplicates, almost always the same way:

1. They are signed in to the desktop app and click an Invite in chat.
2. Chat links open a new browsing context. The desktop shell hands every new
   window to the operating system's default browser, which is often one they
   never use.
3. That browser has no cookie, and Join creates a new Account.

The people this hurts least understand what a cookie is.

The server cannot tell two cookieless visitors apart from one person on two
browsers. With no passwords and no email addresses, nothing a stranger types
can prove they are someone. Any duplicate check would be a guess that is wrong
in both directions, and fingerprinting by IP or device would be a privacy cost
taken from everybody to save some people a click.

## Decision

**A cookieless visitor is asked before an Account is made.** Pressing Join on
the invite card without a session asks one question first: new to Voxly, or
already have an account here?

- **New** asks for a nickname (and Turnstile, when configured) and accepts as
  today.
- **Already have an account** runs Link from the invite card itself. The member
  reads a Link code off their other Device, types it here, and approves it there.
  When the session is collected, the same card accepts the Invite as that Account.
  The Invite token stays in page memory throughout. It never enters a URL,
  storage, or the Link request.
- **A Recovery code** is offered under it, quieter, for a member with no other
  Device to hand. Its cost, every other Device signed out, is stated before
  the code is entered (ADR-0014).

Both answers are presented as equals. Hiding "already have one" behind a small
link would rebuild the bug in copy.

**An Invite for this Installation, clicked inside Voxly, opens inside Voxly.**
A plain click on an invite link whose origin is this Installation is handled in
place. It is never handed to a new window, and so never to another browser.
This is where most duplicates start. Fixing it in the web client also fixes the
desktop, with no new native authority. Modified and middle clicks keep their
ordinary meaning.

**A valid Invite shows who is there.** The invite preview adds the member count
and online count for the Invite's Server, beside the name, expiry and remaining
uses it already returns.

- The counts cover people. Bots, ended Memberships, banned Accounts and Deleted
  accounts are excluded, and an Invisible member is counted as offline
  (ADR-0035).
- An invalid Invite still gets the single generic answer and no counts. The
  holder of a valid Invite was handed it on purpose, and the counts tell a
  stranger nothing a link does not already reveal.

**No duplicate is ever refused or merged.** Two Accounts for one person remain
possible. This decision only makes them stop being the default path.

**Links cannot be claimed by the desktop app.** An Invite pasted into another
app still opens in a browser. Taking over https links needs the domain bound
when the app is built:

- macOS Universal Links need an Apple-signed Associated Domains entitlement.
- Windows app URI handlers need an MSIX-packaged identity plus a file on every
  domain.

Every operator has their own domain, and the desktop app ships as NSIS, so
neither mechanism applies.

**Someone who says they have an Account is offered their desktop app, and the
server says whether it opened.** Most members use Voxly in a browser and have
no app, so Join never tries one: it asks the question at once and nobody waits.
Answering "yes, I have an account" on a Windows browser, where the app runs,
puts **Open in the Voxly app** above the Link code. The card prepares a
hand-off as that screen opens: an `invite_launches` row that names the Invite,
lives ten minutes and joins once. The button opens
`voxly://open?origin=…&launch=<id>`, the same envelope a sign-in launch uses
(ADR-0027). The URI carries the public id and never the Invite token, so the
desktop shell needed no change.

- Inside the app, the web interface asks the server whether a launch id is an
  Invite hand-off before treating it as a sign-in. An Invite opens its card,
  in the Account the app already holds, and the member presses Join once.
- The app reading the card marks the hand-off opened. The browser polls that
  status and shows "Opened in the Voxly app" with one way back. Nothing is
  inferred from focus or timing.
- With no answer after five seconds the card points to the Link code beneath
  the button. An answer that arrives later still wins.
- The browser never signs in on this path, so a hand-off grants nothing the
  Invite token did not: whoever holds a valid Invite could join with it anyway.

## Alternatives considered

- **Merge or deduplicate Accounts on the server.** Nothing identifies a person
  across browsers. A merge would be an Account takeover with a friendly name.
- **Auto-accept for a signed-in visitor.** The card exists to show what you are
  joining, so a signed-in visitor presses Join once, as in other chat products.
  A wrong click costs a membership the member then has to leave.
- **Put the Invite token in `voxly://`.** Custom-scheme URIs are logged and can
  be intercepted by another local app. The deep-link contract refuses
  credentials, and an Invite is one.
- **Sign the browser in by scanning a QR code with a signed-in phone.** It would
  remove typing from the browser path, but it is the shape of QR-login
  phishing: a stranger shows a code, the member scans and approves, and the
  stranger's browser holds their Account. ADR-0021 closed the same hole for
  desktop sign-in. The app hand-off removes typing without moving an Account.
- **Try the app on every Join.** Two members in three use a browser and have
  no app; trying one would make them wait, and on Windows can raise a system
  prompt for an app they never installed, at the moment a newcomer forms a
  first impression.
- **Detect the app by watching for the page to lose focus.** It guesses, and
  it guesses wrong whenever a browser shows its own "Open Voxly?" prompt. The
  app telling the server it read the hand-off is a fact.

## Consequences

- Invite redemption now reaches the Link and Recovery flows, so those flows
  must work when embedded in the card as well as on their own routes.
- A member with no other Device and no Recovery code still has only the new
  Account path. ADR-0014 accepted that, and it stands.
- The preview reads live connections to count who is online, so the count is
  as fresh as the request and is never stored.
