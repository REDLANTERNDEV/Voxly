# ADR-0025 — Desktop recovery and frame appearance remain finite

A saved WebView2 Notification denial has no browser permission UI in Voxly.
Allow the current Installation to request a parameterless reset of that one
permission to DEFAULT through its own profile. Never clear cookies, storage,
media permissions or another Installation's profile. Reset does not grant
permission or enable alerts; the member explicitly enables them afterward.
A cached denial can require Quit/reopen, so reset never reloads an active call.
See Microsoft's [profile permission API](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2profile4).

Windows 11 frame colors follow the rendered Voxly theme through a separate
light/dark command. Native code owns the palette and honors high contrast;
the document cannot supply arbitrary colors. Keep native window controls and
avoid changing WebView2's preferred color scheme, which would break Auto.
The bundled welcome window uses its own fixed palette. Windows 10 lacks the
explicit caption-color attributes. See Microsoft's [DWM attributes](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute).

Both remote commands validate exact current origin, unique window label and
generation under the Installation replacement lock, extending ADR-0022/0024.
They grant no navigation, filesystem, shortcut, media or update authority.
Installed Windows 11 permission recovery, toast delivery and appearance remain
acceptance requirements, beyond portable tests and macOS compilation.
