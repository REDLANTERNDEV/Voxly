import { useEffect } from "react";
import type { Translate } from "../../app/types.js";
import { ArrowIcon } from "../../components/ui/Icons.js";
import { BrandLockup,NavLink } from "../../components/ui/Navigation.js";
import { LanguageSwitch } from "../../components/ui/Primitives.js";
import { trackLandingView,type AnalyticsSettings } from "../../lib/analytics.js";
import { type LanguageCode,type TranslationKey } from "../../lib/i18n.js";
const landingPrincipleKeys = ["privateAccess", "selfHosted", "lowFootprint"] as const;
export function LandingPage({ language, analytics, signedOutReason = "", t, onLanguageChange, onNavigate }: {
  /** Why the member is here rather than in the app, when it is worth saying. */
  signedOutReason?: "" | "reused" | "revoked"; language: LanguageCode; analytics: AnalyticsSettings | null; t: Translate; onLanguageChange: (language: LanguageCode) => void; onNavigate: (path: string) => void }) {
  // Analytics arrive with /api/config, so this runs once the operator's
  // configuration is known and stays a no-op when none is configured.
  useEffect(() => trackLandingView(analytics), [analytics]);
  return (
    <main className="landing-page">
      {/* Being signed out because a session was seen in two places is not the
          same as never having been signed in, and a member who was using Voxly
          a moment ago is owed the difference (ADR-0015). */}
      {signedOutReason ? (
        <p className="landing-signed-out" role="alert">
          {t(signedOutReason === "reused" ? "session.reused" : "session.revoked")}
        </p>
      ) : null}
      <header className="landing-nav" style={{ viewTransitionName: "persistent-nav" }}>
        <BrandLockup subtitle={t("landing.brandSubtitle")} href="/" onNavigate={onNavigate} />
        <nav className="landing-nav-actions" aria-label={t("landing.nav")}>
          <LanguageSwitch language={language} t={t} onLanguageChange={onLanguageChange} />
          <NavLink className="btn btn-ghost" href="/invite" onNavigate={onNavigate}>
            <span>{t("landing.haveInvite")}</span>
          </NavLink>
        </nav>
      </header>

      <section className="landing-hero">
        <div className="landing-hero-copy">
          <p className="label">{t("landing.label")}</p>
          <h1>{t("landing.title")}</h1>
          <p className="landing-copy">{t("landing.copy")}</p>
          <div className="landing-actions">
            <NavLink className="btn btn-primary" href="/invite" onNavigate={onNavigate}>
              <ArrowIcon />
              <span>{t("landing.inviteCta")}</span>
            </NavLink>
          </div>
          {/* The two ways back for somebody who already has an account. Quiet,
              below the invite, and in that order deliberately: linking costs
              nothing and recovery signs every other Device out, so the cheap
              path has to be the one a member finds first (ADR-0014). */}
          <p className="landing-returning small muted">
            <NavLink className="landing-returning-link" href="/link-device" onNavigate={onNavigate}><span>{t("landing.linkDevice")}</span></NavLink>
            <span aria-hidden="true"> · </span>
            <NavLink className="landing-returning-link" href="/recover" onNavigate={onNavigate}><span>{t("landing.recover")}</span></NavLink>
          </p>
        </div>
        <div className="landing-signal" aria-hidden="true">
          <span className="landing-signal-ring landing-signal-ring-one" />
          <span className="landing-signal-ring landing-signal-ring-two" />
          <span className="landing-signal-ring landing-signal-ring-three" />
          <span className="landing-signal-core"><img src="/brand/logo-mark.svg" alt="" width="54" height="54" /></span>
        </div>
      </section>

      <ul className="landing-principles" aria-label={t("landing.features")}>
        {landingPrincipleKeys.map((key) => (
          <li key={key}>{t(`landing.${key}.title` as TranslationKey)}</li>
        ))}
      </ul>
    </main>
  );
}

export function InviteRequiredScreen({ language, t, onLanguageChange, onNavigate }: { language: LanguageCode; t: Translate; onLanguageChange: (language: LanguageCode) => void; onNavigate: (path: string) => void }) {
  return (
    <main className="invite-shell">
      <div className="invite-layout invite-layout-simple">
        <section className="invite-card">
          <BrandLockup subtitle={t("landing.brandSubtitle")} />
          <LanguageSwitch language={language} t={t} onLanguageChange={onLanguageChange} />
          <div>
            <p className="label">{t("invite.privateInvite")}</p>
            <h1>{t("invite.missingTitle")}</h1>
            <p className="muted small">{t("invite.missingCopy")}</p>
          </div>
          <div className="invite-status is-loading" aria-live="polite">
            <strong>{t("invite.linkRequired")}</strong>
            <span className="muted small">{t("invite.askOwner")}</span>
          </div>
          <NavLink className="btn btn-primary full-width" href="/" onNavigate={onNavigate}>
            <ArrowIcon />
            <span>{t("invite.backToHome")}</span>
          </NavLink>
        </section>
      </div>
    </main>
  );
}
