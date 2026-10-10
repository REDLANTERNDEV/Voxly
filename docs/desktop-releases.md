# Desktop release operations

Voxly uses GitHub Releases for initial Windows desktop distribution. The
`Windows desktop release candidate` workflow prepares updater-signed installers and a
manifest; it does **not** publish, tag, or deploy them. Ordinary `desktop:build`
and `Windows desktop feasibility` builds remain unsigned, with updates disabled.
The desktop client remains a feasibility build until installed Windows acceptance
is complete. No production key or certificate has been created by this change.

## Hosting and ownership

The repository's distributor owns release approval, the HTTPS update channel,
updater private key and backups, and Windows signing identity. These are separate
from any self-hosted Installation owner. Hosting a desktop installer on GitHub
adds no hosted dependency to application Docker deployment, media or TURN.

Default official update manifest:

`https://github.com/REDLANTERNDEV/Voxly/releases/download/desktop-stable/latest.json`

Default installer base for version `VERSION`:

`https://github.com/REDLANTERNDEV/Voxly/releases/download/desktop-vVERSION/`

The `desktop-stable` release is a dedicated channel pointer. Replace its
`latest.json` only after the new version's installer and signature are available
and tested. Keep versioned release assets immutable. Container releases and
GitHub's generic “latest release” do not influence this channel. The channel
release and versioned releases must be publicly readable: the updater sends no
GitHub credentials, browser cookies or Installation identity.

GitHub currently documents no total release-size or bandwidth quota, with a
2 GiB maximum per file. Public repositories use standard GitHub-hosted Actions
runners without charges; private repositories have plan-specific Actions quotas.
Signing services or CA certificates may carry separate costs. Confirm repository
visibility and account billing before depending on public distribution.
[Release quotas](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases),
[Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Operator-owned builds may override the HTTPS channel and artifact base and use
their own updater key and Authenticode identity. Do not mix official and operator
trust. Remote Installation content cannot override compiled configuration.
Losing the updater key prevents signing subsequent automatic updates for installed
clients. Back it up securely with its password and a documented recovery owner.
Rotation needs a release trusted by the old key; losing or compromising that
chain may require a manually obtained replacement installer. Do not silently
replace keys or downgrade clients to recover a release.

## Protected release configuration

Initial GitHub distribution uses the workflow's `windows_signing: none` mode.
It requires no Windows certificate or signing-service subscription. Tauri updater
signatures remain mandatory and independently verified. Windows may show
unknown-publisher/SmartScreen warnings; this mode is not suitable for Store EXE
submission. Provenance records `windowsSigning: none` and a null Authenticode
thumbprint. Neither mode publishes a release automatically.

Create a `desktop-production` GitHub environment with required reviewers and
release-branch restrictions. The workflow is manual and has read-only repository
permissions. To additionally sign for Windows, select `windows_signing: authenticode`.
Its exported-PFX signing adapter needs a CA-issued Authenticode
certificate accepted by Windows; a self-signed certificate is not production or
Store signing. A provider using hardware/cloud signing needs a separately
reviewed Tauri `signCommand` adapter; the current workflow does not configure one.
Do not assume a purchased certificate is exportable as PFX.

Environment variables (public configuration):

| Variable                     | Value                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `DESKTOP_UPDATER_PUBLIC_KEY` | Entire base64 text from the Tauri public-key file, not a path                                                           |
| `DESKTOP_PUBLISHER`          | Distributor label; defaults to repository owner for `none`, verified signing/Store identity required for `authenticode` |
| `DESKTOP_TIMESTAMP_URL`      | Authenticode only: your signing provider's HTTPS RFC 3161 timestamp endpoint                                            |
| `DESKTOP_UPDATE_ENDPOINT`    | Optional override of the repository's `desktop-stable/latest.json` URL                                                  |
| `DESKTOP_RELEASE_BASE_URL`   | Optional override of the versioned installer directory; trailing slash required                                         |

Environment secrets:

| Secret                            | Purpose                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `DESKTOP_UPDATER_PRIVATE_KEY`     | Tauri updater private-key content                                                     |
| `DESKTOP_UPDATER_PASSWORD`        | Password protecting that key                                                          |
| `DESKTOP_AUTHENTICODE_PFX_BASE64` | Authenticode only: exported signing certificate including private key, base64 encoded |
| `DESKTOP_AUTHENTICODE_PASSWORD`   | Authenticode only: PFX import password                                                |

For the initial `none` mode, configure only `DESKTOP_UPDATER_PUBLIC_KEY`,
`DESKTOP_UPDATER_PRIVATE_KEY` and `DESKTOP_UPDATER_PASSWORD`. The publisher label
in this mode defaults to the repository owner; it is metadata, not a Windows-verified
identity. `DESKTOP_PUBLISHER` may override it. Certificate/password and timestamp
settings are needed only for `authenticode`. Update hosting URLs use the defaults above.

Generate production keys only after choosing their owner and backup procedure,
on an authorized trusted machine, using the Tauri signer CLI. Do not paste private
keys into chats, commit them, print them in logs, or upload them as artifacts.
[Tauri updater signing](https://v2.tauri.app/plugin/updater/),
[Windows signing](https://v2.tauri.app/distribute/sign/windows/).

Before running the workflow, set the same stable desktop version in
`apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`, and
`apps/desktop/src-tauri/tauri.conf.json`; update Cargo/npm lockfile metadata as
needed. The version input must match all three. The workflow fails on missing or
malformed trust/signing configuration. It compiles the fixed endpoint/key,
creates updater-signed NSIS artifacts, verifies the selected Windows signing mode
on both executable and installer (timestamped Authenticode or no Authenticode),
then independently verifies the updater signature
against the embedded public key before generating `latest.json`.

Artifacts include installer, `.sig`, `latest.json`, `SHA256SUMS`, and
`provenance.json` (commit, target, run, public-key fingerprint, certificate
thumbprint). The ephemeral signing certificate is removed after the job. No
private material is included in uploaded artifacts. The production installer
is machine-wide and bundles WebView2's offline installer; it is larger than the
feasibility bootstrapper build. Rust/npm lockfiles and the pinned toolchain are
preserved. This does not promise byte-identical signed builds.

## Release and installed acceptance

After authorization to publish, create `desktop-vVERSION` from the tested
commit and upload the candidate assets unchanged. Run installed Windows tests
before promoting `latest.json` to the dedicated `desktop-stable` release. A
single-version smoke test is insufficient: install an older updater-signed build and
update to a strictly newer one sharing its endpoint and public key.

Record Windows build, WebView2 version, versions/commits, signing identity,
network, duration and actual results in
[Windows acceptance](desktop-windows-acceptance.md). No installed update test is
marked passed based on macOS compilation or unit tests.

- Startup, hourly background and manual checks; idle, call, muted/receive-only voice, camera,
  screen/computer audio, microphone test, retained capture and pending join/capture.
- Cancel download and cancel installation confirmation: calls/capture survive.
- Failed/absent endpoint, wrong platform/version, invalid key/signature, altered
  artifact and interrupted download: no installer runs; Retry works.
- Confirm installation: chooser capture and pending permission results end,
  Installation capture ends, updater exits only after explicit consent.
- Installer launch failure/interruption, first restart, old/new executable
  version, saved addresses, language, shortcuts and isolated WebView2 sessions.
- Installation content cannot invoke update commands or updater plugin commands.
- Check artifact checksums, publisher, silent `/S` install, machine-wide scope and
  offline WebView2 setup on a machine without WebView2.

Verified downloads are held only in memory and discarded on cancellation or
app exit. Downloads are limited to 256 MiB and three minutes; checks have a
10-second request timeout. Failures do not close the current Installation.
After a failed install attempt, reopen the Installation; if Windows installation
was interrupted, obtain the same or a newer signed installer through the
distributor. Do not delete WebView2 profiles or preferences to recover.

The final NSIS launch uses a local checked process adapter rather than the pinned
Tauri plugin's unchecked `ShellExecuteW`/exit path. Staging errors happen before
Installation teardown. Process launch errors keep the chooser running with a
recovery message; calls already ended by consent must be rejoined. Successful
launch retains the installer until NSIS finishes and restarts Voxly; reserved
staging directories are cleaned on later startup. Installer failure after launch
or interruption still needs Windows acceptance and manual recovery testing.

## Microsoft Store readiness

The initial Store route can be an EXE listing of the signed, offline NSIS
installer. Submit a fixed versioned HTTPS installer URL and `/S` for silent
installation. Keep submitted binaries immutable, supply listing/privacy/support
information, and complete certification. Store EXE listings permit app-managed
updates and do not deliver updates to existing clients themselves. Our updater
can remain the authority for this route.
[Microsoft EXE requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements),
[EXE updates](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/publish-update-to-your-app-on-store),
[Tauri Store guidance](https://v2.tauri.app/distribute/microsoft-store/).

An MSIX release would be separate work: reserve package/publisher identity,
package the desktop executable, use Store-managed updates with NSIS updater
configuration absent, and test protocol registration, notifications, shortcut/tray
behavior, WebView2 profile locations and migration/coexistence with EXE installs.
Microsoft supplies MSIX signing/hosting; an EXE Store listing still needs the
publisher's CA signing certificate. No MSIX package or Store listing is created
here. [Distribution paths](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path).

## Local verification — 2026-10-01

Passed on macOS for this implementation:

```sh
npm run typecheck
npm test
npm run build
npm run typecheck -w @voxly/desktop
npm run test -w @voxly/desktop
npm run build -w @voxly/desktop
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline --all-targets -- -D warnings
node --check apps/desktop/scripts/release.mjs
node --check apps/desktop/scripts/release.test.mjs
node --test apps/desktop/scripts/release.test.mjs
ruby -r yaml -e 'YAML.load_file(ARGV[0]); puts "workflow YAML parsed"' .github/workflows/desktop-release.yml
git -c core.fsmonitor=false diff --check
```

Root tests: 1,601 passed. Desktop tests: 53 TypeScript tests and two release
script tests passed. Native tests: 43 passed. Root/native suites required
loopback-listener permission after the initial sandbox attempts were denied.
The native commands used the available stable Rust toolchain with
`RUSTUP_HOME=/private/tmp/voxly-rustup` and `CARGO_HOME=/private/tmp/voxly-cargo`;
release CI still uses the repository's pinned toolchain. Browser preview of the
unconfigured update UI showed no horizontal overflow at 390px. This verifies
frontend presentation only; signed Windows packaging, installed updater tests,
Store acceptance, and the remaining media/resource gates are unverified.

Program Files packages use NSIS `perMachine` and explicit Voxly installer and
uninstaller icons. Setup and native updates request administrator approval;
NSIS `/R` uses its RunAsUser relaunch path. Validate that the resulting Voxly
process has no elevation. Existing per-user installations require the
[data-preserving reinstall](desktop.md#move-an-existing-per-user-install-to-program-files)
before relying on machine-wide updates. Do not treat a macOS build as Windows
migration or UAC acceptance.
