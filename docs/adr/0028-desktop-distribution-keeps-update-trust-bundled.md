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
and manual checks never reload Installation content or end media. Every install
requires local confirmation, including idle or unreported media state; chooser
capture stops and the Installation webview is destroyed before Windows install.
Endpoint failure, tampered signatures and cancelled downloads leave calls usable.

Native checks run at application startup and hourly while the process remains
alive, including hidden tray sessions. Available installers are downloaded and
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
