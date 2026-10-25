# ADR-0028 — Desktop distribution keeps update trust bundled

GitHub Releases is the initial desktop distribution host, selected on
2026-10-01 to avoid operating another service. Use a dedicated `desktop-stable`
manifest asset and immutable `desktop-vVERSION` installer URLs so application
container releases cannot accidentally become the desktop update channel.
The distributor owns and backs up the updater private key; endpoint and public
key are compiled into the local shell. An Installation can replace neither,
invoke no check/download/install commands, and supply no download paths or installer arguments
([ADR-0019](0019-desktop-keeps-native-authority-local.md)). Changing host or key
later requires a release through the existing trust chain or manual reinstall.

Keep downloads separate from installation. HTTPS downloads are bounded,
cancellable, and verified with Minisign before becoming installable. Startup
and manual checks never reload Installation content or end media. While Voxly
is running, every install requires local confirmation, including idle or
unreported media state; chooser capture stops and the Installation webview is
destroyed before Windows install. Endpoint failure, tampered signatures and
cancelled downloads leave calls usable.

On 2026-10-26 the distributor chose Discord-style launch updates. A plain start
shows the update card while the shell checks for up to three seconds; Home
opens after it. When an update is found, the card fills a real download bar
for up to ninety seconds and then installs it before Home opens. At launch no
Installation, call or capture exists, so the UAC prompt is the consent;
cancelling it keeps the verified download ready in Home. A launch with
arguments — a `voxly://` link, or the reopening after a failed update — opens
Home at once, so a link is never lost to a relaunch and a failing installer
cannot prompt on every start. A slow download carries on in the background.

An update must not look like a first install. The verified installer runs
silently (`/S /R /UPDATE`): no language dialog and no wizard pages. A
staged copy of the shell, named `voxly-update.exe` so the installer's
close-the-running-app step spares it, owns the UAC prompt and shows the card
until the relaunched shell closes it. If the installer fails, the card says so
and reopens the installed version. If the card cannot start, the shell falls
back to the passive installer.

The package stays machine-wide in Program Files, decided again on 2026-10-26:
only an administrator can replace the binary that holds the bundled update
key and native authority, which a per-user install like Discord's would give
up. The cost is one UAC prompt per update.

Native checks run at application startup and hourly while the process remains
alive, including hidden tray sessions. A scheduled check or download that cannot
reach the service — routinely the first one after the PC resumes from sleep —
keeps the last known state and retries after two, then ten minutes; manual
checks and verification failures always report. Available installers are downloaded and
verified quietly. Cancelling a download or discarding it suppresses automatic
download of that version for the current process; a manual download remains
available. Installation content may read only public update status/version and
request local review; native caller checks scope both commands to the current
Installation. The local shell alone collects installation consent. A ready
package adds a tray-menu action; ordinary discovery never opens a dialog or
steals focus. Mandatory deadlines and automatic restart/rejoin remain proposed,
not implemented by this presentation change.

On 2026-10-02 the distributor chose initial GitHub distribution without a paid
Windows certificate. Release candidates always require updater signing; Windows
Authenticode is a separate, explicit workflow mode. Certificate-free candidates
may trigger Windows unknown-publisher warnings and must never claim a verified
Windows publisher. Selecting Authenticode still requires a valid timestamped
signature; absent credentials must fail rather than silently downgrade.
Bundle Evergreen WebView2 offline in production NSIS
installers to prepare the Microsoft Store EXE route, which still uses the app's
updater. MSIX would instead require a separately validated package/identity and
Store-managed updates with this NSIS updater disabled; it is not implemented.
Keep unsigned feasibility CI distinct. The candidate workflow creates reviewable
artifacts without publishing; candidates do not close Windows media or
installed-update acceptance gates. See [release operations](../desktop-releases.md).
