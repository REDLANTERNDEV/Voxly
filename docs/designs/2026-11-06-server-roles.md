# Design — Server roles and Server settings (2026-11-06)

Decision record: ADR-0038. Status: designed, not built. Tickets:
`.scratch/roles/issues/` (local, not committed).

## Problem

Only the Server owner can run a Server. The one thing an owner can hand out is
a per-member "can invite" switch. Owners want two things:

- **helpers**: an Admin who opens Server settings and runs the Server;
- **invite rights by group**: `@everyone` without them, and a Role that has
  them.

Today the owner panel mixes two kinds of section:

- **one Server's settings**: overview, invites, members, server;
- **the whole installation**: Accounts, Deletion requests.

## Stories

- As an owner, I make a member Admin. They then see **Server settings** in the
  server name menu and when they right-click the server icon, and can run the
  Server, except for the few things only I may do.
- As an owner or Admin, I right-click a member in the member list and open
  **Roles ›**. I see every Role, ticked if the member holds it. I tick or
  untick them one after another without the submenu closing. Roles I cannot
  change are greyed out and explain why.
- As an owner or Admin, I switch **Create invites** on or off for `@everyone`
  or for any Role.
- As an owner, I decide per Role whether its members show as their own group
  in the member list.
- As a member, my name shows in the colour of my highest coloured Role, and
  my profile card lists my Roles.
- As an owner, I put a Role on a Private channel's access instead of listing
  people one by one.

## Settled decisions (grilling Q1–Q23 and Q6b, every recommendation accepted)

**Roles**

1. There is a general Role model. Every Server starts with three Roles:
   `@everyone`, **Admin** and **Davetçi** (English: **Recruiter**). Owners and
   members with Manage roles create more, up to 50 per Server. A Role name is
   1–32 characters.
2. The **Server owner is not a Role.** They stand above every Role, hold every
   Permission, and are never the subject of a Role action. Who creates a
   Server and who owns it do not change.
3. **Permissions add up.** A member's Permissions are `@everyone` plus every
   Role they hold. There is no Server-level deny. Rank does not change
   Permissions.
4. **Rank decides only who manages whom.** Anyone holding Manage members,
   Voice moderation or Manage roles may act only on people whose rank is
   strictly below theirs. They may give, change, reorder or delete only Roles
   strictly below their own highest Role. The owner is exempt.
5. Only the owner may give, remove or change **Admin**. Only the owner may
   switch **Administrator** on or off on any Role.
6. The order of the Roles:
   - **Admin** is always first and cannot be deleted.
   - **`@everyone`** is always last. It cannot be deleted, given or removed.
   - **Davetçi** is an ordinary Role.
   - The others reorder by dragging, or with "Move up / Move down" for
     keyboard users.
7. Deleting a Role removes it from its members and from every Channel access.
8. **Bots hold no Roles.** No Role action targets a Bot. The rules for
   summoning and controlling the Music bot do not change, and there is no new
   Music Permission.

**Permissions**

9. The Permissions are a closed list:

   | Permission           | What it covers                                                                                  |
   | -------------------- | ----------------------------------------------------------------------------------------------- |
   | **Create invites**   | Creating an Invite. Off on `@everyone` by default.                                              |
   | **Manage channels**  | Creating, editing, deleting and reordering Channels and categories; the layout; Channel access. |
   | **Manage server**    | The Server's name, AFK room and welcome notice.                                                 |
   | **Manage roles**     | Creating, editing, reordering and deleting Roles below your own; giving and removing them.      |
   | **Manage members**   | Kick, ban and unban; editing another member's nickname.                                         |
   | **Voice moderation** | Moderator mute and deafen; disconnecting someone from voice; moving someone to another channel. |
   | **Manage messages**  | Pinning; clearing reactions; deleting another member's message.                                 |
   | **Manage invites**   | Seeing and revoking every Invite; creating Invites that never expire.                           |
   | **Administrator**    | Every Permission above, plus every Private channel.                                             |

10. Some actions stay **owner-only for good**:
    - deleting the Server;
    - access links;
    - the Invite trail.

**Visibility**

11. Each Role has a switch, **"Show members separately in the member list"**,
    off by default and placed on the Role's Display tab:
    - Someone in several such Roles appears once, under the highest.
    - Offline members stay under Offline.
    - The group heading reads `ROLE — online count`.
12. **Colour.** A member's name takes the colour of their highest coloured
    Role, in the member list and in chat. Colours come from a fixed palette
    that is legible in light and dark themes. A Role without a colour changes
    nothing.
13. **Role labels.** The profile card shows a member's Roles as small coloured
    labels. Role mentions (`@Admin`) are out of scope.

**Surfaces**

14. **The server name menu.** Clicking the server name at the top left of the
    channel rail, or right-clicking the server icon in the workspace rail,
    opens one menu. Each item appears only to members with the matching
    Permission:
    - **Server settings**: any Permission at all;
    - **Invite people**: Create invites;
    - **Create channel** and **Create category**: Manage channels.

    Owner-only items scattered elsewhere today move into this menu.

15. **Server settings** is a full-screen window with a left navigation, in the
    style of Discord's. Its sections:
    - **Overview** (name, AFK room, welcome notice): Manage server.
    - **Roles**: Manage roles.
    - **Members**: Manage members, Voice moderation or Manage roles.
    - **Invites**: Manage invites.
    - **Bans**: Manage members.
    - **Invite trail**, **Access links** and **Delete server**: owner only.

    Members see only the sections their Permissions reach.

16. **The owner panel** keeps only what covers the whole installation:
    Accounts and Deletion requests, plus an installation overview. Its Target
    server picker goes away.
17. **The Role editor** opens from Roles. On the left is the list of Roles with
    a back button and **+**. On the right are three tabs:
    - **Display**: name, colour, the separate-group switch.
    - **Permissions**: one switch per Permission, each with a short
      description; a search box; and **Clear permissions**.
    - **Manage members**: the list, with add and remove.

    `@everyone` shows only the Permissions tab.

18. **The Roles submenu** in the member list's right-click menu:
    - **Roles ›** appears only when the actor can change at least one Role on
      that member. It never appears for the owner, for a Bot, or for someone
      of equal or higher rank.
    - Hovering it, pressing →, or tapping it opens a submenu with every Role,
      each with a checkbox, a colour dot and the Role name. The box is ticked
      when the member holds the Role.
    - Clicking a row toggles that Role at once, and the submenu stays open.
    - Locked rows are greyed out and cannot be clicked, with a reason on
      hover:
      - `@everyone` is always ticked: "Everyone has this role".
      - Roles at or above the actor's rank, and Admin for anyone but the
        owner: "Only the owner can give this role", or "You can only manage
        roles below yours".
    - Keyboard: ← closes the submenu and Space toggles a row. Screen readers
      hear `menuitemcheckbox` with checked and disabled states.
    - The context-menu layering and focus rules in `apps/web/AGENTS.md` apply.
19. **The same Roles can be given from two other places:** the Members section
    of Server settings, and the Manage members tab of a Role.
20. **On a phone, Server settings has two steps.** You see the list of
    sections, tap one, and it opens full-screen with a back button. The rules
    in `apps/web/AGENTS.md`'s Narrow Layout section apply.

**Channel access and live updates**

21. **Channel access** takes Roles as well as members. A member may enter a
    Private channel when any of these is true:
    - they are on its Channel access themselves;
    - a Role they hold is on it;
    - they hold Administrator;
    - they are the Server owner.

    Hidden and Listed behave as in ADR-0037. Losing access through a Role takes
    effect at once, exactly as losing a direct grant does.

22. **Live updates.** Changing a Role, a Permission or a member's Roles
    reaches every open client without a reload. Losing a Permission closes
    the matching Server settings section and menu items at once. The server
    re-checks every action regardless.
23. **Upgrade.**
    - Every existing Server gains the three Roles.
    - Each Membership with `can_invite` set is placed in Davetçi.
    - `@everyone` starts with no Permissions.

    No one gains or loses a right in the upgrade. The `can_invite` column
    stays, unread. The member menu's "can invite" switch and the owner
    overview's "Inviters" figure go away.

## Choices left to the implementer

- **The Permission list on the wire.** Recommended: a fixed list of named
  Permissions in `@voxly/shared`, with every check reading it. A bit field
  would save little at this size and would make tests and audits harder to
  read.
- **The client's Permissions.** `ServerSummary` gains the actor's effective
  `permissions` and `rank`. The client never works them out from Roles itself.
- **Audit.** Every Role and Permission change is recorded with the actor, as
  existing owner actions are (`audit(...)`).

## Ruled out

- Ordered override with deny, where a higher Role overrides a lower one.
- Fixed Roles only.
- Letting an Admin grant Administrator.
- Calling the invite Role "Inviter" (that word is the Invite trail's).
- Role mentions.
- A Music Permission.
- Roles the system hands out automatically. That belongs to the levels and
  leagues work, which builds on this model.

## Slices

These are the tickets in `.scratch/roles/issues/`:

1. **Roles exist, and invites run on them.** Schema, upgrade, the Permission
   resolver, the Roles submenu.
2. **The server name menu, the Server settings window, and the owner panel
   split.**
3. **The Roles section and the Role editor.**
4. **Channels and invites run on Permissions.**
5. **Members, voice and messages run on Permissions, with rank.**
6. **Colour, separate groups and Role labels.**
7. **Roles on Channel access, and Administrator in Private channels.**

Ticket 1 blocks everything. Ticket 2 blocks 3, 4 and 5. Ticket 3 blocks 6
and 7.
