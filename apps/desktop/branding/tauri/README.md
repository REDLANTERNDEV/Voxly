# Voxly desktop branding

This directory is the Tauri v2 branding boundary used by the feasibility
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

Windows setup and uninstall use `icons/setup-dark.ico`, exported from the
existing `source/app-icon-monochrome.png` dark mark at 16, 24, 32, 48, 64,
128 and 256 pixels. This keeps the mark visible against the light installer
background. The installed application's silver icons remain separate.
