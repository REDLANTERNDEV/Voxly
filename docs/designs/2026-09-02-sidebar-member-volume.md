# Sidebar member volume controls

## Goal

Make the existing listener-owned per-member volume control available from the
shared member context menu for every remote member, regardless of whether that
member is currently in a voice room. The control must work consistently for
remote owners and ordinary members in both the left voice sidebar and the right
member directory.

## Design

`MemberActionMenu` remains the single implementation for both sidebar surfaces.
The current user's row never receives a volume control. Every other member row
receives the existing `VolumeControl`, backed by the existing `memberVolumes`
map and `onMemberVolumeChange` callback. The right directory removes its
`voiceRoom` requirement when wiring remote volume; the left rail already only
contains voice participants and therefore needs no new state path.

The slider retains its existing localized label, integer range of 0–200%,
default of 100%, and listener-local persistence. Changing volume while a member
is absent from voice updates the stored preference and has no immediate audio
effect; the existing remote-audio path applies it when audio becomes available.
Owner-only moderation, nickname, invite, move, and disconnect permissions are
unchanged.

## Validation

Add regression coverage that checks the right directory passes volume controls
to remote members without a voice-room condition, while preserving the left
rail wiring and the self-row exclusion. Run the web test workspace, web
type-check, and `git diff --check`.

## Implementation plan

1. Update `apps/web/src/components/shell/MemberPanel.tsx` so a remote member
   receives `memberVolumes[user.userId] ?? DEFAULT_VOLUME_PERCENT` and the
   matching `onMemberVolumeChange` callback without requiring `voiceRoom`.
   Keep `user.userId !== currentUser.id` as the only volume guard.
2. Extend `apps/web/test/member-volume-menu.test.ts` with a regression assertion
   that the right-sidebar `MemberActionMenu` wiring is remote-member based and
   does not gate volume on `voiceRoom`.
3. Run the focused web test file, the web workspace test suite, web type-check,
   and `git diff --check`; inspect the final status and diff for unrelated
   changes.
