# Voxly desktop development

The Windows-first Tauri client is a **feasibility build**. It is not a completed
desktop release. Windows 11 is the primary test target. The shell can be built
on macOS for development, but installation windows are currently enabled only
on Windows. Core self-hosting requires no Rust, desktop runtime, or new server
configuration.

Read the [revised plan](designs/2026-09-29-windows-desktop.md),
[platform review](designs/2026-09-29-desktop-platform-review.md), and
[Windows acceptance record](desktop-windows-acceptance.md).

## Run locally

Install Node.js 22+, npm, the pinned Rust toolchain, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Windows builds
need Microsoft C++ Build Tools with the desktop C++ workload and Windows SDK,
plus WebView2. The NSIS installer uses the Evergreen runtime bootstrapper;
therefore a machine without WebView2 needs internet access for installation.
The default installation is per-user and does not require running Voxly as an
administrator.

```sh
npm install
npm run desktop:dev
```

For a browser-only chooser layout/localization preview:

```sh
npm run dev:shell -w @voxly/desktop
```

Open `http://127.0.0.1:1420`. Native buttons are disabled in this preview. Its
media checks use the browser, so they do not establish Tauri compatibility.

## Connect and sign in

Add an installation origin, for example `https://chat.example.com`. Paths,
credentials, query strings, and fragments are refused. Loopback HTTP development
origins are allowed: `http://127.0.0.1:3000`, `http://localhost:3000`, or
`http://[::1]:3000`. Plain HTTP LAN/public addresses are refused. HTTPS certificate
validation is never disabled.

The shell checks the existing unauthenticated `/api/health` endpoint before
opening an installation, using an eight-second timeout, no redirects, and a
bounded response. This does not prove the interface/media are working; it only
rejects an unreachable or invalid health response. A failed replacement health
check leaves the existing installation window intact. If its interface later
fails, use the tray's Installations action and Retry loading or another address.

The installation interface provides Invite and Link code paths. On an updated
installation, **Sign in with browser** appears on the desktop Link a device
screen. Start it, open the verification address in your default browser, compare
the number shown in both windows, and approve. The desktop window collects its
session through its own webview; the approving browser remains signed in. The
request expires after 90 seconds; leaving the desktop screen sends cancellation.
The existing Link code path remains available: open Account & devices on a
signed-in browser, generate a code, enter it in the desktop interface, and
approve the matching confirmation number.

For local development, start the server on port 3000 and Vite on port 5173.
Set `VOXLY_PUBLIC_URL=http://127.0.0.1:5173` when starting the server **and**
when creating the first owner, so the one-use owner link opens the web UI. The
desktop installation address is also `http://127.0.0.1:5173`.
If an owner was already created with a link to port 3000 and that link has
expired, do not run `owner:create` again. With the same `DATABASE_PATH`, run
`npm run owner:claim -w @voxly/server -- --base-url http://127.0.0.1:5173`
and open its new one-use link.

Close hides a window to the tray. Tray Show Voxly restores the installation;
Installations restores the chooser. Retry, disconnect, switching addresses, and
Quit warn that media will end. Until a bridge is available, that confirmation is
conservative even when there is no active call. Quit closes the webview and all
capture; hiding keeps it alive and is subject to Windows acceptance testing.

Windows stores chooser preferences under the application local-data directory
for `app.voxly.desktop` (`%LOCALAPPDATA%\app.voxly.desktop` in a standard profile).
Each canonical origin has a separate `profiles/<sha256-of-origin>` browser data
directory. Preferences contain addresses, language, and first-use acknowledgement,
not session tokens. Browser cookies remain in their own profiles. Forget address
only removes the chooser entry; revoke the Device in Account & devices to sign
it out. Do not share or commit browser data directories.

## Verify and package

```sh
npm run typecheck
npm test
npm run build
npm run build -w @voxly/desktop
cd apps/desktop/src-tauri
cargo fmt --check
cargo check --locked
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

From the repository root on Windows:

```sh
npm run desktop:build
```

The NSIS test installer is written under
`apps/desktop/src-tauri/target/release/bundle/nsis/`. The
`Windows desktop feasibility` GitHub workflow can produce this unsigned artifact
on demand or on desktop pull requests. It does not publish a release and does
not test Windows 11 hardware or interactive media.

The Rust toolchain is pinned in `src-tauri/rust-toolchain.toml`; npm and Cargo
lockfiles are checked in. Keep the Tauri 2.11 family of crate, runtime, macros,
and build tools together when updating the lockfile: an unconstrained transitive
upgrade to a newer Tauri minor can introduce incompatible internal APIs.
`cargo --locked` is required in checks. Update the lockfile deliberately and
rerun the installer checks after any dependency/toolchain change.

## Distribution and updating

This experiment has no native updater, no update endpoint, and no signing key.
Installation-delivered interface updates use Voxly's existing version checker;
while media is active an update waits behind an explicit reload notice. End
media before reloading. Shell releases will be separately signed and distributed
after feasibility passes.

Before a production shell release, the distributor must establish a fixed HTTPS
manifest endpoint, protect the updater private key in release secrets, embed the
matching public key, and separately configure Windows Authenticode signing.
Tauri updater signatures do not replace Authenticode. Installing a Windows
update exits the app, so confirmation/track cleanup precede installation. Never
take the updater URL or public key from a connected installation. The
[revised plan](designs/2026-09-29-windows-desktop.md#milestone-4-signed-release-and-shell-updates)
lists the required failure tests.
