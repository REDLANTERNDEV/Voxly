# Desktop microphone consent stays per Installation

Windows microphone requests use an owned Voxly dialog and WebView2's per-profile
permission persistence, rather than granting access at startup or disabling
runtime permission controls. Only explicit choices for the current top-level
Installation may persist; dismissal, frame requests and stale requests cannot
save a grant. Audio settings reset only that Installation's microphone decision,
so one address cannot change another address's consent.

This keeps consent local to the device and retains Windows privacy restrictions,
separate camera permission and the existing voice-join/test acquisition flow.
Unsupported runtimes keep their permission prompt. Screen capture retains the
runtime chooser and sharing indicator; suppressing browser security UI through
runtime flags would weaken a boundary shared with untrusted remote content.
