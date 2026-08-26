import type { PublicUser } from "@voxly/shared";
import { useEffect,useState } from "react";
import { claimAccessLink,claimOwnerSession } from "../../api.js";
import type { Translate } from "../../app/types.js";
import { BrandLockup,NavLink } from "../../components/ui/Navigation.js";
import { LanguageSwitch } from "../../components/ui/Primitives.js";
import { type LanguageCode } from "../../lib/i18n.js";
export function OwnerClaimScreen({ token, language, t, onLanguageChange, onClaimed }: { token: string; language: LanguageCode; t: Translate; onLanguageChange: (language: LanguageCode) => void; onClaimed: (user: PublicUser) => void }) {
  const [status, setStatus] = useState<"loading" | "danger">("loading");

  useEffect(() => {
    let isMounted = true;
    if (!token) {
      setStatus("danger");
      return;
    }

    claimOwnerSession(token)
      .then((response) => {
        if (isMounted) {
          onClaimed(response.user);
        }
      })
      .catch(() => {
        if (isMounted) {
          setStatus("danger");
        }
      });

    return () => {
      isMounted = false;
    };
  }, [onClaimed, token]);

  return (
    <main className="invite-shell">
      <div className="invite-layout invite-layout-simple">
        <section className="invite-card">
          <BrandLockup subtitle={t("ownerClaim.label")} />
          <LanguageSwitch language={language} t={t} onLanguageChange={onLanguageChange} />
          <div>
            <p className="label">{t("ownerClaim.label")}</p>
            <h1>{t("ownerClaim.title")}</h1>
            <p className="muted small">{t("ownerClaim.copy")}</p>
          </div>
          <div className={`invite-status ${status === "danger" ? "is-danger" : "is-loading"}`} aria-live="polite">
            <strong>{status === "danger" ? t("ownerClaim.invalid") : t("ownerClaim.checking")}</strong>
            <span className="muted small">{status === "danger" ? t("ownerClaim.invalidCopy") : t("ownerClaim.checkingCopy")}</span>
          </div>
        </section>
      </div>
    </main>
  );
}

export function AccessClaimScreen({ token, t, onNavigate, onClaimed }: { token: string; t: Translate; onNavigate: (path: string) => void; onClaimed: (user: PublicUser, serverId: string) => void }) {
  const [status, setStatus] = useState<"loading" | "danger">("loading");

  useEffect(() => {
    let isMounted = true;
    if (!token) {
      setStatus("danger");
      return;
    }
    claimAccessLink(token)
      .then((response) => {
        if (isMounted) onClaimed(response.user, response.serverId);
      })
      .catch(() => {
        if (isMounted) setStatus("danger");
      });
    return () => {
      isMounted = false;
    };
  }, [onClaimed, token]);

  return (
    <main className="invite-shell">
      <section className="invite-card">
        <BrandLockup />
        <div className={`invite-status ${status === "danger" ? "is-danger" : "is-loading"}`} aria-live="polite">
          <strong>{status === "danger" ? t("accessClaim.invalid") : t("accessClaim.restoring")}</strong>
          <span className="muted small">{status === "danger" ? t("accessClaim.invalidCopy") : t("accessClaim.restoringCopy")}</span>
        </div>
        {status === "danger" ? <NavLink className="btn btn-primary full-width" href="/invite" onNavigate={onNavigate}><span>{t("landing.haveInvite")}</span></NavLink> : null}
      </section>
    </main>
  );
}
