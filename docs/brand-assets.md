# Brand assets

Voxly brand assets are grouped by delivery target instead of by export size.
The web client owns the browser-facing assets under
`apps/web/public/brand/`:

- `svg/` contains the canonical vector mark, wordmark, and lockups.
- `web/` contains favicon, Apple touch icon, and social-card exports.
- `pwa/` contains installable and maskable manifest icons.

The current browser entry points use the primary mark for compact surfaces,
the monochrome mark for pinned-tab and decorative backgrounds, and the light
horizontal lockup for documentation on light backgrounds. The web manifest and
social metadata point at the platform-specific exports rather than duplicating
them under generic filenames.

The future Tauri client has its own boundary at
`apps/desktop/branding/tauri/`. Its `icons/` directory is a Tauri v2 bundle
drop-in, while `source/` contains the source inputs and manifest for icon
regeneration. See that directory's README for integration steps.
