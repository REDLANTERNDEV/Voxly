import { useCallback,useEffect,useState,type ReactNode } from "react";
import type { Translate } from "../app/types.js";
import { isSteamGameOverlay } from "../lib/browserEnvironment.js";
import { readLanguageChoice,saveLanguageChoice,translate,type LanguageCode } from "../lib/i18n.js";
import { LanguageSwitch } from "./ui/Primitives.js";
import { BrandLockup } from "./ui/Navigation.js";

export function BrowserCompatibilityGate({ userAgent, children }: { userAgent: string; children: ReactNode }) {
  if (!isSteamGameOverlay(userAgent)) return children;
  return <SteamOverlayWarning />;
}

function SteamOverlayWarning() {
  const [language, setLanguage] = useState<LanguageCode>(() => readLanguageChoice());
  const t = useCallback<Translate>((key, values) => translate(language, key, values), [language]);
  const changeLanguage = useCallback((next: LanguageCode) => {
    saveLanguageChoice(next);
    setLanguage(next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return (
    <main className="invite-shell steam-overlay-warning">
      <div className="invite-layout invite-layout-simple">
        <section className="invite-card" aria-labelledby="steamOverlayWarningTitle">
          <BrandLockup subtitle={t("landing.brandSubtitle")} />
          <LanguageSwitch language={language} t={t} onLanguageChange={changeLanguage} />
          <div>
            <p className="label">{t("browser.steamOverlayLabel")}</p>
            <h1 id="steamOverlayWarningTitle">{t("browser.steamOverlayTitle")}</h1>
          </div>
          <div className="invite-status is-danger">
            <strong>{t("browser.steamOverlayStatus")}</strong>
            <span className="muted small">{t("browser.steamOverlayCopy")}</span>
          </div>
        </section>
      </div>
    </main>
  );
}
