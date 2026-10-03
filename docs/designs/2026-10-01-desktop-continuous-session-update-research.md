# Desktop updates during continuous voice sessions

Researched on 2026-10-01. Scope: Windows desktop applications that remain
running for days, including muted or receive-only voice sessions. This is a
research note and proposed policy, not implemented behavior or Windows
acceptance evidence. Only first-party sources are used.

## What the vendors document

| Application | Checking / preparation | Applying an update | Preventing indefinite old-version use | Ongoing calls and muted sessions |
| --- | --- | --- | --- | --- |
| Discord Windows | The cited announcement does not specify a background check interval or download policy. | Since 2025-10-07, automatic updates at **application startup** are delayed until a release is mandatory or the client is several versions behind. The green arrow provides a manual update action. | Mandatory designation and version lag affect startup. An exact lag count or continuous-session deadline is not published in this source. | No documented rule for forcibly restarting a running call, nor a special muted-call exception. [Discord patch notes](https://discord.com/blog/discord-patch-notes-october-7-2025) |
| Teams Windows | Checks at application startup and every few hours in the background; downloads and stages available updates. | Application restart is required; automatic updating uses an idle period. A visible restart action lets the member apply it sooner. | In-app warnings for clients 1–3 months old; clients older than 3 months get a blocking page offering update, IT help or the web client. Critical releases bypass the normal release schedule. | The current update page does not define idle or document how a live, muted or receive-only call affects it. [Teams update process](https://learn.microsoft.com/en-us/microsoftteams/teams-client-update), [member update instructions](https://support.microsoft.com/en-us/teams/notifications-settings/update-microsoft-teams) |
| Slack Windows | Automatic updating is enabled by default and can be managed by IT. Exact checking/download intervals are not stated in these sources. | The Direct Download app exposes Check for Updates and Restart to Apply Update, plus a help-icon badge/update card. Store distribution has a separate update path. | Desktop versions normally have 12–18 months of support; an unsupported version cannot access Slack until upgraded. | These documents do not state whether huddles suppress automatic installation or whether a support deadline disconnects an already-running huddle. [Configuration](https://slack.com/help/articles/11906214948755-Manage-desktop-app-configurations), [update instructions](https://slack.com/help/articles/360048367814-Update-the-Slack-desktop-app), [support lifecycle](https://slack.com/intl/en-gb/help/articles/1500001836081-Slack-support-life-cycle-for-operating-systems-app-versions-and-browsers) |

Application startup/restart above means starting or restarting the application;
it does not require restarting Windows. Showing an existing tray window is
not evidence of a new process startup.

## Evidence dates and limits

- Discord's announcement is dated 2025-10-07. It supports conditional startup
  updating, not the claim that Discord forcibly updates every running call or
  installs every available release immediately at startup. No later first-party
  continuous-call policy was located in this research.
- The current Teams update-process page reports an update date of 2026-07-20.
  The separate [Windows Autopatch Teams page](https://learn.microsoft.com/en-us/windows/deployment/windows-autopatch/manage/windows-autopatch-teams)
  (updated 2025-01-04) mentions 40 minutes of computer idle before installation.
  That older page also describes a different release cadence. Do not generalize
  its 40-minute number to all current Teams builds or interpret computer idle as
  proof that a muted call is safe to interrupt.
- Slack's help pages were consulted on 2026-10-01; visible publication dates
  were not provided. Its published next desktop cutoff is 2026-11-09 for
  4.47.59 and below; that is a future cutoff at the time of this note.
  [Support schedule](https://slack.com/intl/en-gb/help/articles/1500001836081-Slack-support-life-cycle-for-operating-systems-app-versions-and-browsers)
- Slack distinguishes security improvements by severity in release guidance;
  this does not establish an emergency forced-restart timer.
  [Security guidance](https://slack.com/help/articles/360048367814-Update-the-Slack-desktop-app)
- Slack's [Windows deployment guide](https://slack.com/help/articles/212475728-Deploy-Slack-for-Windows)
  describes MSIX auto-updating and disables the internal updater when installed
  via an AppInstaller file. Distribution method changes update authority; it
  does not supply a documented huddle-interruption policy.

The sources show a recurring pattern: prepare updates automatically, offer a
visible application restart, and eventually retire unsupported versions. They
do not establish a universal industry rule that inactivity or a muted
microphone permits silent call termination. Published access-blocking rules
also do not prove that a server immediately terminates existing media.

## Proposals for Voxly

These are design recommendations derived from the comparison, not descriptions
of Discord, Teams or Slack behavior. Exact periods remain product decisions.

1. Check on application startup and periodically while running. Prepare and
   verify updates in the background, with recoverable endpoint/download errors.
   A tray session must still discover releases without Windows or app restart.
2. Separate ordinary releases from an explicit minimum-supported-version or
   critical-security policy. Do not make each cosmetic/feature release mandatory.
   Published version retirement is the stronger anti-deferral pattern shown by
   Teams and Slack; startup-only enforcement does not solve the 24/7 case.
3. For an ordinary ready update, show a persistent, quiet action; avoid sound,
   repeated modal prompts and focus theft. Apply automatically only at an
   explicitly defined safe boundary, such as a fresh app launch before media,
   or a period with no voice room, capture, media check or pending operation.
   Muted/receive-only room membership still counts as ongoing media.
4. For mandatory updates, announce the reason and an absolute deadline early,
   offer Update now and bounded postponement, and persist the same deadline
   across restarts, tray hiding, mute/deafen and new calls. A continuing call
   cannot extend the deadline forever. Before expiry, prefer a naturally safe
   boundary. At expiry, a visible final warning and controlled teardown may be
   necessary; silently inferring that an unattended person consented is unsafe.
   The existence and timing of this deadline are a Voxly proposal, not a vendor
   claim. Account for clock changes and machine sleep when enforcing it.
5. Define network/signature/install failure separately from postponement. Never
   destroy a working call merely because a manifest endpoint is unreachable or
   an update is invalid. Do not repeatedly exit into a failed installer. A
   genuinely unsupported client can be denied a new connection with a clear
   fallback, but this is separate from forcing an installation.
6. Keep enforcement authority in the bundled local shell. Remote Installation
   content may not choose the update endpoint/key, installer or restart timer.
   If minimum-version/deadline metadata is added, authenticate that policy as
   well as the artifact; artifact signatures alone do not authenticate arbitrary
   new manifest fields. A client-reported version is not attestation against a
   deliberately modified binary. Server compatibility rules can protect server
   contracts, but should not be represented as proof of a genuine desktop build.
7. Offer a planned restart/reconnect action that explains the interruption.
   Any future restoration must preserve muted/deafened preferences and fresh
   server authorization, never silently start camera or screen capture, and
   handle revoked Devices or Memberships. It is not currently acceptance-tested.
8. Keep Installation-delivered interface reloads separate from shell installs;
   both need continuous-session discovery and media boundaries. A new interface
   build does not automatically mean the Windows executable needs replacement.

ADR-0028 currently requires local confirmation for **every** installation,
including idle states. Automatic safe-boundary installation or mandatory
deadline teardown would change that documented decision. Resolve it explicitly
before implementation; this note does not override the ADR.

## Validation needed for a chosen policy

- Leave a signed Windows client running and hidden to tray across release
  discovery, download and the chosen grace period.
- Independently cover microphone-on, muted, deafened, receive-only, camera,
  screen/computer-audio capture, chooser media checks and pending joins.
- Confirm that tray showing, mute toggling, new calls, restart and sleep do not
  reset a mandatory deadline; background downloads do not interrupt media.
- Verify offline endpoints, malformed or unauthenticated policy, bad artifact
  signatures, unavailable installers and failed restart without a boot loop.
- Confirm clear English/Turkish copy, keyboard access, screen-reader warnings,
  and no routine focus theft. Record real Windows evidence separately.
