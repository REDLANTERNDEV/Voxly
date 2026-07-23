import type { PublicUser } from "@voxly/shared";
import type { FormEvent } from "react";
import { useCallback,useEffect,useRef,useState } from "react";
import { acceptInvite,ApiError,previewInvite } from "../../api.js";
import { extractInviteToken,inviteAvailabilityCopy,inviteStatusTitle,statusClass } from "../../app/presentation.js";
import type { Translate } from "../../app/types.js";
import { ArrowIcon } from "../../components/ui/Icons.js";
import { BrandLockup } from "../../components/ui/Navigation.js";
import { LanguageSwitch } from "../../components/ui/Primitives.js";
import { type LanguageCode } from "../../lib/i18n.js";
import { loadTurnstile } from "../../lib/turnstile.js";
export function InviteScreen({ initialToken, existingUser, currentUser, turnstileSiteKey, onAccepted, language, t, onLanguageChange }: { initialToken: string; existingUser: boolean; currentUser: PublicUser | null; turnstileSiteKey: string | null; onAccepted: (user: PublicUser, serverId: string) => void; language: LanguageCode; t: Translate; onLanguageChange: (language: LanguageCode) => void }) {
  const [inviteToken, setInviteToken] = useState(initialToken);
  const [serverName, setServerName] = useState("");
  const [invitePreview, setInvitePreview] = useState<{ expiresAt: string | null; remainingUses: number | null } | null>(null);
  const [nickname, setNickname] = useState("");
  const [status, setStatus] = useState<"ready" | "loading" | "valid" | "danger">("ready");
  const [fieldError, setFieldError] = useState("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const onTurnstileToken = useCallback((token: string) => {
    setTurnstileToken(token);
    setFieldError("");
  }, []);
  const onTurnstileUnavailable = useCallback(() => {
    setTurnstileToken("");
    setFieldError(t("invite.turnstileUnavailable"));
  }, [t]);

  useEffect(() => {
    const token = extractInviteToken(initialToken);
    if (token.length < 24) {
      setServerName("");
      setInvitePreview(null);
      return;
    }
    let cancelled = false;
    void previewInvite(extractInviteToken(initialToken))
      .then((response) => {
        if (!cancelled) {
          setServerName(response.serverName);
          setInvitePreview({ expiresAt: response.expiresAt, remainingUses: response.remainingUses });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setServerName("");
          setInvitePreview(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [initialToken]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!existingUser && !nickname.trim()) {
      setFieldError(t("invite.chooseNicknameError"));
      return;
    }
    if (!inviteToken.trim()) {
      setFieldError(t("invite.pasteError"));
      return;
    }
    if (turnstileSiteKey && !existingUser && !turnstileToken) {
      setFieldError(t("invite.turnstileRequired"));
      return;
    }

    setFieldError("");
    setStatus("loading");
    try {
      const response = await acceptInvite(extractInviteToken(inviteToken), nickname.trim(), turnstileToken || undefined);
      setStatus("valid");
      onAccepted(response.user, response.serverId);
    } catch (error: unknown) {
      setStatus("danger");
      if (turnstileSiteKey) {
        setTurnstileToken("");
        setTurnstileResetKey((current) => current + 1);
      }
      if (error instanceof ApiError && error.code === "turnstile_failed") {
        setFieldError(t("invite.turnstileFailed"));
      } else if (error instanceof ApiError && error.code === "already_server_member") {
        const serverId = error.data?.serverId;
        if (currentUser && typeof serverId === "string") {
          onAccepted(currentUser, serverId);
          return;
        }
        setFieldError(t("invite.alreadyMember"));
      } else if (error instanceof ApiError && error.code === "server_banned") {
        setFieldError(t("invite.serverBanned"));
      } else {
        setFieldError(t("invite.unavailable"));
      }
    }
  }

  return (
    <main className="invite-shell">
      <div className="invite-layout invite-layout-simple">
        <section className="invite-card">
          <BrandLockup subtitle={t("landing.brandSubtitle")} />
          <LanguageSwitch language={language} t={t} onLanguageChange={onLanguageChange} />
          <div>
            <p className="label">{t("invite.privateInvite")}</p>
            <h1>{serverName ? t("invite.joinServerTitle", { server: serverName }) : t("invite.joinTitle")}</h1>
            <p className="muted small">{existingUser ? t("invite.joinExistingCopy") : t("invite.chooseName")}</p>
          </div>
          <div className={`invite-status ${statusClass(status)}`} aria-live="polite">
            <strong>{inviteStatusTitle(status, t)}</strong>
            <span className="muted small">{status === "danger" ? t("invite.askOwner") : inviteAvailabilityCopy(invitePreview, language, t)}</span>
          </div>
          <form onSubmit={submit}>
            <label className="form-field" htmlFor="inviteLink">
              <span>{t("invite.codeLabel")}</span>
              <input className="input" id="inviteLink" name="inviteLink" value={inviteToken} onChange={(event) => setInviteToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="VX-7K2M…" />
            </label>
            {!existingUser ? <label className="form-field field-gap" htmlFor="nickname">
              <span>{t("invite.nickname")}</span>
              <input className="input" id="nickname" name="nickname" value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="Wren…" autoComplete="nickname" maxLength={32} />
            </label> : null}
            {turnstileSiteKey && !existingUser ? (
              <div className="form-field field-gap">
                <span>{t("invite.humanCheck")}</span>
                <TurnstileWidget
                  siteKey={turnstileSiteKey}
                  resetKey={turnstileResetKey}
                  onToken={onTurnstileToken}
                  onUnavailable={onTurnstileUnavailable}
                />
              </div>
            ) : null}
            <p className="error-text" aria-live="polite">{fieldError}</p>
            <button className="btn btn-primary full-width" type="submit" disabled={status === "loading"}><ArrowIcon /><span>{status === "loading" ? t("common.checking") : t("invite.join")}</span></button>
          </form>
        </section>
      </div>
    </main>
  );
}

export function TurnstileWidget({ siteKey, resetKey, onToken, onUnavailable }: { siteKey: string; resetKey: number; onToken: (token: string) => void; onUnavailable: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let isActive = true;
    let widgetId: string | null = null;
    onToken("");

    loadTurnstile()
      .then((turnstile) => {
        if (!isActive || !containerRef.current) return;
        widgetId = turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme: "auto",
          callback: (token) => {
            if (isActive) onToken(token);
          },
          "expired-callback": () => {
            if (isActive) onToken("");
          },
          "error-callback": () => {
            if (isActive) onUnavailable();
          }
        });
      })
      .catch(() => {
        if (isActive) onUnavailable();
      });

    return () => {
      isActive = false;
      if (widgetId && window.turnstile) {
        window.turnstile.remove(widgetId);
      }
    };
  }, [onToken, onUnavailable, resetKey, siteKey]);

  return <div className="turnstile-widget" ref={containerRef} />;
}
