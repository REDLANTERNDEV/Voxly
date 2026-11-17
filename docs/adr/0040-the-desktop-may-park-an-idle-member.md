# ADR-0040 — The desktop app may park an idle member in the AFK room

- **Status:** accepted
- **Date:** 2026-11-17
- **Context:** narrows the "Idle never moves" rule in `CONTEXT.md` and
  `apps/web/AGENTS.md`; builds on [ADR-0035](0035-a-status-is-held-by-the-server-and-invisible-is-absence.md)'s
  machine-wide desktop signal

## Context

Voxly once moved idle members to the AFK room and then stopped. A browser sees
input only inside its own window, so a member playing a fullscreen game with
their microphone muted looked exactly like one who had left, and moving them
pulled a present person out of the conversation and muted them. Idle became a
dot and nothing else.

ADR-0035 then gave the desktop app a machine-wide signal: on Windows the shell
reports `active` when input happened anywhere on the machine and `away` when the
session is locked. Members asked for what Discord and Steam do — someone who has
really been gone for a long time is moved out of the conversation room.

## Decision

**Only machine-wide evidence moves a member.** A desktop installation that has
received at least one activity signal moves its member into their Server's AFK
room once no input has reached the machine for the Server's AFK timeout. The
bridge existing is not enough, because it exists on every platform and only
Windows samples. A browser is never moved.

**The move never comes sooner than 30 minutes.** A move costs more than a dot,
so a Server whose timeout is 15 minutes shows Idle at 15 and moves at 30.

**A lock does not hurry the move.** A locked machine is Idle at once, as before,
but the wait for a move counts from the last real input or speech.

**The member's own client carries it out** through the ordinary join an owner's
move already uses, which applies the AFK room's microphone lock and leaves the
previous room atomically. The server gains no endpoint and no new authority: it
already lets any member join the AFK room. A Server whose owner deleted its AFK
room moves nobody.

## Consequences

- Members using the browser and the desktop app are treated differently by the
  same Server setting. The setting's hint says so in both languages.
- The move depends on the member's client, so a modified client can stay in a
  room while idle. That is no worse than today: nothing stops it from rejoining.
- A member at the keyboard of another machine, with the desktop app idle on
  this one, is moved. That is the same outcome the signal already gives the dot.
