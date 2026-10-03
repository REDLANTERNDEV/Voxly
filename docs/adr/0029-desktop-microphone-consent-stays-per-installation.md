---
status: deprecated
---

# Desktop microphone consent stays per Installation

The custom owned Voxly microphone dialog was removed on 2026-10-02 after
installed Windows use reported repeated prompts during joins and media actions.
Microphone requests now use the previous WebView2 permission flow and each
Installation's isolated profile. Reset-only microphone and camera recovery actions in Audio settings clear
only the selected profile permission on explicit user action; they do not
intercept permission requests or acquire media. Windows privacy restrictions and separate camera
permission remain effective; no microphone permission is granted at startup.

Screen capture keeps the existing runtime chooser and sharing indicator. The
host application supplies its own Windows taskbar identity without modifying
runtime-owned permission or sharing windows.
