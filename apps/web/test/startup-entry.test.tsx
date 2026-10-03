import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRoutes } from "../src/app/AppRoutes.js";
import { InviteScreen } from "../src/features/auth/InviteScreen.js";
import { OwnerClaimScreen,AccessClaimScreen } from "../src/features/auth/ClaimScreens.js";
import { LinkDeviceScreen } from "../src/features/auth/LinkDeviceScreen.js";
import { RecoverScreen } from "../src/features/auth/RecoverScreen.js";
import { translate } from "../src/lib/i18n.js";
const noop = () => {};
const base = {
  route: { name: "text" as const, serverId: "fixture", roomId: "fixture" },
  user: { id: "fixture", nickname: "Mira", role: "member" as const, bannedAt: null },
  authState: "ready" as const, rtcConfigReady: true, workspaceReady: false, workspaceError: false,
  shellProps: null, messages: [], language: "en" as const, timeFormat: "auto" as const,
  t: (key: Parameters<typeof translate>[1], values?: Record<string,string | number>) => translate("en",key,values),
  renderSurface: (surface: React.ReactNode) => surface, turnstileSiteKey: null, analytics: null, signedOutReason: "" as const,
  completeAuthentication: noop, loadAcceptedServer: async () => {}, onOwnerClaimed: noop, onAccessClaimed: noop,
  navigate: noop, changeLanguage: noop, textRoomOutbox: [], textRoomActions: null
};
it("keeps the workspace skeleton until channel data arrives and exposes loading failures", () => {
  assert.match(renderToStaticMarkup(<AppRoutes {...base} />), /app-shell-skeleton/);
  assert.match(renderToStaticMarkup(<AppRoutes {...base} workspaceError rtcConfigReady={false} />), /could not start/i);
});
it("shows no invite acceptance form before the session is resolved", () => {
  const html = renderToStaticMarkup(<AppRoutes {...base} route={{ name: "invite", token: "" }} user={null} authState="loading" />);
  assert.match(html,/account-entry-loading/);
  assert.doesNotMatch(html,/<form|nickname|inviteToken/);
});
it("uses one shared account-entry header and frame for all entry forms in both languages", () => {
  const previous=Object.getOwnPropertyDescriptor(globalThis,"window");
  Object.defineProperty(globalThis,"window",{configurable:true,value:{location:{search:"",origin:"http://fixture"}}});
  try {
  for (const language of ["en","tr"] as const) {
    const entry = { language, t: (key: Parameters<typeof translate>[1],values?: Record<string,string | number>) => translate(language,key,values), onLanguageChange: noop, turnstileSiteKey: null };
    const screens = [
      <InviteScreen {...entry} initialToken="" existingUser={false} currentUser={null} timeFormat="auto" onAccepted={noop} />,
      <OwnerClaimScreen {...entry} token="" onClaimed={noop} />,
      <AccessClaimScreen {...entry} token="" onClaimed={noop} onNavigate={noop} />,
      <LinkDeviceScreen {...entry} onLinked={noop} />,
      <RecoverScreen {...entry} onRecovered={noop} />
    ];
    for (const screen of screens) {
      const html=renderToStaticMarkup(screen);
      assert.equal((html.match(/class="account-entry"/g)??[]).length,1);
      assert.equal((html.match(/class="auth-page-header"/g)??[]).length,1);
    }
  }
  } finally { if(previous)Object.defineProperty(globalThis,"window",previous); else Reflect.deleteProperty(globalThis,"window"); }
});
it("applies the stored theme before React mounts", () => {
  const main=readFileSync("src/main.tsx","utf8");
  assert.ok(main.indexOf("applyThemeChoice(readThemeChoice())")<main.indexOf("createRoot(document"));
});
