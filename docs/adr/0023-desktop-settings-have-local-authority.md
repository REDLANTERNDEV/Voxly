# ADR-0023 — Desktop settings appear in Voxly and keep local authority

The production welcome screen chooses an Installation and its startup behavior;
it does not own everyday audio, shortcut or notification configuration. Present
those controls through the corresponding Voxly Settings sections while keeping
OS shortcut registration, saved Installation selection and update trust in the
bundled native application. This separates where a member finds a setting from
who can change the underlying resource: moving presentation into the connected
application must not give an Installation general native authority
([ADR-0019](0019-desktop-keeps-native-authority-local.md)). Any future bridge must
offer a bounded settings intent or a validated finite setting, with current
origin/generation checks; never expose general IPC or remote updater control.

After successful browser-approved sign-in, offer a selected-by-default local
choice to remember that Installation and open it on startup. The remembered
origin comes from the locally selected Installation, not an authentication
payload or external link. Members can disable startup opening, change the
preferred Installation, or explicitly return to welcome. A failed startup
connection offers Retry and Choose another installation. This keeps returning
members out of setup without treating a link as authority to replace a call or
select an arbitrary host. Detailed production requirements live in the
[desktop experience design](../designs/2026-09-30-desktop-product-experience.md).
