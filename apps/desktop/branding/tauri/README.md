# Voxly desktop branding

This directory is the Tauri v2 branding boundary reserved for the future
desktop client. It is intentionally separate from the web public directory so
desktop bundle binaries are not copied into the browser build.

## Tauri setup

When the desktop app is scaffolded, copy `icons/` to
`apps/desktop/src-tauri/icons/` and merge `tauri.conf.icons.json` into the
desktop Tauri configuration. The `source/` files are the reusable inputs for
regenerating desktop and mobile icons with the Tauri CLI.
