# Voxly desktop branding

This directory is the Tauri v2 branding boundary used by the
desktop client. It is intentionally separate from the web public directory so
desktop bundle binaries are not copied into the browser build.

## Tauri setup

The desktop configuration references these icons directly rather than copying
them into another tracked directory. `tauri.conf.json` here remains the portable
branding fragment. The `source/` files are the reusable inputs for
regenerating desktop and mobile icons with the Tauri CLI. The regular app mark
is transparent so Windows, macOS, and Linux can apply their own icon shape;
`app-icon-background.png` and `app-icon-foreground.png` remain separate for
adaptive icon composition.

Windows Explorer uses `icons/setup-package.ico`: the exact dark vector mark
on a silver rounded plate from `source/setup-package.svg`, exported at 16, 24,
32, 48, 64, 128 and 256 pixels. The NSIS GUI initialization hook restores
`icons/setup-dark.ico` inside setup. Uninstall still uses that dark icon, and
the installed application's silver icons remain unchanged. Installed Windows
validation must inspect Explorer, the wizard, taskbar, and shortcuts independently.
