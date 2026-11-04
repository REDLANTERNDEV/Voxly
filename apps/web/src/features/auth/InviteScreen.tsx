import { AuthEntryFrame } from "./AuthEntryFrame.js";
import type { InvitePreview, PublicUser } from "@voxly/shared";
import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  acceptInvite,
  ApiError,
  createInviteLaunch,
  fetchInviteLaunch,
  fetchServerRooms,
  previewInvite,
  type InviteReference
} from "../../api.js";
import { desktopOpenLink } from "../../lib/desktopLinks.js";
import { inviteAvailabilityCopy } from "../../app/presentation.js";
import type { Translate } from "../../app/types.js";
import { ArrowIcon } from "../../components/ui/Icons.js";
import { type TranslationKey, type LanguageCode } from "../../lib/i18n.js";
import { extractInviteToken } from "../../lib/invites.js";
import { nextInviteJoinStep, serverMark, type InviteJoinEvent, type InviteJoinStep } from "../../lib/inviteJoin.js";
import { firstServerRoomPath, resolveInitialRoute } from "../../lib/navigation.js";
import type { TimeFormatPreference } from "../../lib/timeFormat.js";
import { LinkCodeClaim } from "./LinkCodeClaim.js";
import { RecoveryRedeem } from "./RecoveryRedeem.js";
import { TurnstileWidget } from "./TurnstileWidget.js";

/**
 * The invite card: which Server, how many people, and one Join (ADR-0036).
 *
 * There is no token field once a link brought the visitor here — the token is
 * held in memory and the address bar is scrubbed. A visitor with no session is
 * asked whether they are new before anything is created, so somebody who
 * already has an Account links this browser to it and joins as themselves.
 */
export function InviteScreen({
  initialToken,
  initialLaunchId,
  existingUser,
  currentUser,
  turnstileSiteKey,
  onAccepted,
  language,
  timeFormat,
  t,
  onLanguageChange
}: {
  initialToken: string;
  /** Inside the desktop app: the public id of a browser's hand-off, in place of a token (ADR-0036). */
  initialLaunchId?: string;
  existingUser: boolean;
  currentUser: PublicUser | null;
  turnstileSiteKey: string | null;
  onAccepted: (user: PublicUser, serverId: string) => void;
  language: LanguageCode;
  timeFormat: TimeFormatPreference;
  t: Translate;
  onLanguageChange: (language: LanguageCode) => void;
}) {
  const [inviteToken, setInviteToken] = useState(() => extractInviteToken(initialToken));
  const [pasted, setPasted] = useState("");
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [previewState, setPreviewState] = useState<"loading" | "ready" | "invalid">("loading");
  const [step, setStep] = useState<InviteJoinStep>("card");
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<TranslationKey | "">("");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<"idle" | "opening" | "opened" | "dismissed">("idle");
  const [appSlow, setAppSlow] = useState(false);
  const reference: InviteReference | null = initialLaunchId
    ? { inviteLaunchId: initialLaunchId }
    : inviteToken.length >= 24
      ? { inviteToken }
      : null;
  const referenceKey = initialLaunchId ? `launch:${initialLaunchId}` : inviteToken;
  // Most members use Voxly in a browser and have no app, so nobody is made to
  // wait on one. Only somebody who says they already have an Account, on
  // Windows where the app runs, is offered it: their app can take the Invite
  // and join as the Account it holds, with nothing to type (ADR-0036).
  const offersApp = !existingUser && !initialLaunchId && desktopAppMayBeInstalled();
  const onTurnstileToken = useCallback((token: string) => {
    setTurnstileToken(token);
    setFieldError("");
  }, []);
  const onTurnstileUnavailable = useCallback(() => {
    setTurnstileToken("");
    setFieldError("invite.turnstileUnavailable");
  }, []);

  // The token is in hand; take it out of the address bar and history, the way
  // Link device does with its code.
  useEffect(() => {
    if (initialToken) window.history.replaceState(null, "", "/invite");
  }, [initialToken]);

  useEffect(() => {
    if (!reference) {
      setPreview(null);
      setPreviewState(inviteToken ? "invalid" : "loading");
      return;
    }
    let cancelled = false;
    setPreviewState("loading");
    void previewInvite(reference)
      .then((response) => {
        if (cancelled) return;
        setPreview(response);
        setPreviewState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setPreview(null);
        setPreviewState("invalid");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `referenceKey` is the reference.
  }, [referenceKey]);

  // Prepared as soon as they say they have an Account: a browser opens another
  // app only from the press itself, so the link must be ready by then.
  useEffect(() => {
    if (!offersApp || step !== "link" || handoffId) return;
    let cancelled = false;
    void createInviteLaunch(inviteToken)
      .then((launch) => {
        if (!cancelled) setHandoffId(launch.id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [offersApp, step, handoffId, inviteToken]);

  // The app reading the hand-off is the answer; nothing is guessed from focus.
  // With no answer after a few seconds the code below is pointed out, and a
  // late answer still wins.
  useEffect(() => {
    if (!handoffId || handoff !== "opening") return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - started > 5000) setAppSlow(true);
      void fetchInviteLaunch(handoffId)
        .then((launch) => {
          if (launch.status !== "waiting") setHandoff("opened");
        })
        .catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [handoffId, handoff]);

  const move = (event: InviteJoinEvent) => {
    const next = nextInviteJoinStep(step, event);
    setFieldError("");
    if (next === "accept") void accept();
    else setStep(next);
  };

  function openInApp() {
    const href = handoffId ? desktopOpenLink(window.location.origin, false, handoffId) : null;
    if (!href) return;
    setAppSlow(false);
    setHandoff("opening");
    window.location.assign(href);
  }

  async function accept(chosenNickname = "") {
    setFieldError("");
    setBusy(true);
    try {
      if (!reference) return;
      const response = await acceptInvite(reference, chosenNickname, turnstileToken || undefined);
      onAccepted(response.user, response.serverId);
    } catch (error: unknown) {
      setBusy(false);
      if (turnstileSiteKey && !existingUser) {
        setTurnstileToken("");
        setTurnstileResetKey((current) => current + 1);
      }
      if (error instanceof ApiError && error.code === "turnstile_failed") {
        setFieldError("invite.turnstileFailed");
      } else if (error instanceof ApiError && error.code === "already_server_member") {
        const serverId = error.data?.serverId;
        if (currentUser && typeof serverId === "string") {
          onAccepted(currentUser, serverId);
          return;
        }
        setFieldError("invite.alreadyMember");
      } else if (error instanceof ApiError && error.code === "server_banned") {
        setFieldError("invite.serverBanned");
      } else {
        setFieldError("invite.unavailableError");
      }
    }
  }

  // Link or Recovery just set a session cookie for the Account this person
  // already had, so the Invite is accepted as them. This page started out
  // signed out, so it reloads into the Server rather than navigating in place.
  const joinAsSignedIn = useCallback(() => {
    const fallback = resolveInitialRoute({ isAuthenticated: true, inviteToken: null });
    if (!reference) return;
    void acceptInvite(reference, "")
      .then((response) => response.serverId)
      .catch((error: unknown) => {
        const serverId = error instanceof ApiError ? error.data?.serverId : undefined;
        if (typeof serverId === "string") return serverId;
        throw error;
      })
      .then(async (serverId) => firstServerRoomPath(serverId, (await fetchServerRooms(serverId)).rooms))
      .catch(() => fallback)
      .then((path) => window.location.assign(path === "/" ? fallback : path));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `referenceKey` is the reference.
  }, [referenceKey]);

  function submitNickname(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!nickname.trim()) {
      setFieldError("invite.chooseNicknameError");
      return;
    }
    if (turnstileSiteKey && !turnstileToken) {
      setFieldError("invite.turnstileRequired");
      return;
    }
    void accept(nickname.trim());
  }

  function submitPasted(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = extractInviteToken(pasted);
    if (!token) {
      setFieldError("invite.pasteError");
      return;
    }
    setFieldError("");
    setStep("card");
    setInviteToken(token);
  }

  const errorLine = (
    <p className="error-text" aria-live="polite">
      {fieldError ? t(fieldError) : ""}
    </p>
  );
  const back = (
    <button className="btn btn-ghost" type="button" onClick={() => move({ kind: "back" })}>
      {t("invite.back")}
    </button>
  );

  let body: React.ReactNode;
  if (handoff === "opened") {
    body = (
      <div className="invite-status is-valid invite-handoff" aria-live="polite">
        <strong>{t("invite.openedInApp")}</strong>
        <span className="muted small">{t("invite.openedInAppCopy")}</span>
        <button className="btn btn-ghost" type="button" onClick={() => setHandoff("dismissed")}>
          {t("invite.continueInBrowser")}
        </button>
      </div>
    );
  } else if (!inviteToken && !initialLaunchId) {
    body = (
      <form onSubmit={submitPasted}>
        <label className="form-field" htmlFor="inviteLink">
          <span>{t("invite.codeLabel")}</span>
          <input
            className="input"
            id="inviteLink"
            name="inviteLink"
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {errorLine}
        <button className="btn btn-primary full-width" type="submit">
          <ArrowIcon />
          <span>{t("invite.showInvite")}</span>
        </button>
      </form>
    );
  } else if (previewState === "invalid") {
    body = (
      <div className="invite-status is-danger" aria-live="polite">
        <strong>{t("invite.unavailable")}</strong>
        <span className="muted small">{t("invite.askOwner")}</span>
      </div>
    );
  } else if (step === "choose") {
    body = (
      <div className="invite-fork">
        <strong>{t("invite.forkTitle")}</strong>
        <button className="invite-fork-option" type="button" onClick={() => move({ kind: "existing" })}>
          <strong>{t("invite.forkExisting")}</strong>
          <span className="muted small">{t("invite.forkExistingCopy")}</span>
        </button>
        <button className="invite-fork-option" type="button" onClick={() => move({ kind: "new" })}>
          <strong>{t("invite.forkNew")}</strong>
          <span className="muted small">{t("invite.forkNewCopy")}</span>
        </button>
        {back}
      </div>
    );
  } else if (step === "new") {
    body = (
      <form onSubmit={submitNickname}>
        <label className="form-field" htmlFor="nickname">
          <span>{t("invite.nickname")}</span>
          <input
            className="input"
            id="nickname"
            name="nickname"
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            placeholder={t("invite.nicknamePlaceholder")}
            autoComplete="nickname"
            maxLength={32}
            autoFocus
          />
        </label>
        {turnstileSiteKey ? (
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
        {errorLine}
        <div className="invite-actions">
          {back}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            <ArrowIcon />
            <span>{busy ? t("common.checking") : t("invite.joinServer")}</span>
          </button>
        </div>
      </form>
    );
  } else if (step === "link") {
    body = (
      <div className="invite-fork">
        {offersApp ? (
          <div className="invite-app-handoff">
            <button
              className="btn btn-primary full-width"
              type="button"
              disabled={!handoffId || (handoff === "opening" && !appSlow)}
              onClick={openInApp}
            >
              {handoff === "opening" && !appSlow ? t("invite.openingApp") : t("invite.openInApp")}
            </button>
            <p className="muted small" aria-live="polite">
              {appSlow ? t("invite.appDidNotOpen") : t("invite.orUseCode")}
            </p>
          </div>
        ) : (
          <p className="muted small">
            {t("invite.linkThenJoin", { server: preview?.serverName ?? t("invite.joinTitle") })}
          </p>
        )}
        <LinkCodeClaim
          t={t}
          onLinked={joinAsSignedIn}
          turnstileSiteKey={turnstileSiteKey}
          onLostDevice={() => move({ kind: "lostDevice" })}
        />
        {back}
      </div>
    );
  } else if (step === "recover") {
    body = (
      <div className="invite-fork">
        <RecoveryRedeem t={t} onRecovered={joinAsSignedIn} turnstileSiteKey={turnstileSiteKey} />
        {back}
      </div>
    );
  } else {
    body = (
      <>
        {existingUser ? <p className="muted small">{t("invite.joinExistingCopy")}</p> : null}
        {errorLine}
        <button
          className="btn btn-primary full-width"
          type="button"
          disabled={busy || previewState !== "ready"}
          onClick={() => move({ kind: "join", signedIn: existingUser })}
        >
          <ArrowIcon />
          <span>{busy ? t("common.checking") : t("invite.joinServer")}</span>
        </button>
      </>
    );
  }

  return (
    <AuthEntryFrame language={language} t={t} onLanguageChange={onLanguageChange}>
      <div className="invite-layout invite-layout-simple">
        <section className="invite-card">
          <p className="label">{t("invite.privateInvite")}</p>
          {(inviteToken || initialLaunchId) && previewState !== "invalid" ? (
            <InviteServerSummary preview={preview} language={language} timeFormat={timeFormat} t={t} />
          ) : (
            <h1>{inviteToken ? t("invite.joinTitle") : t("invite.missingTitle")}</h1>
          )}
          {body}
        </section>
      </div>
    </AuthEntryFrame>
  );
}

/** Which Server an Invite opens, and how many people are there. Shared with the rail's join dialog. */
export function InviteServerSummary({
  preview,
  language,
  timeFormat,
  t
}: {
  preview: InvitePreview | null;
  language: LanguageCode;
  timeFormat: TimeFormatPreference;
  t: Translate;
}) {
  return (
    <div className="invite-server" aria-busy={!preview}>
      <span className="invite-server-mark" aria-hidden="true">
        {preview ? serverMark(preview.serverName) : ""}
      </span>
      <div className="invite-server-copy">
        <h1>{preview ? t("invite.joinServerTitle", { server: preview.serverName }) : t("invite.joinTitle")}</h1>
        {preview ? (
          <p className="invite-headcount">
            <span className="invite-online">
              <span className="invite-online-dot" aria-hidden="true" />
              {t("invite.onlineCount", { count: preview.onlineCount })}
            </span>
            <span>
              {preview.memberCount === 1
                ? t("invite.oneMember")
                : t("invite.memberCount", { count: preview.memberCount })}
            </span>
          </p>
        ) : null}
        <p className="muted small">{inviteAvailabilityCopy(preview, language, t, timeFormat)}</p>
      </div>
    </div>
  );
}

/**
 * The desktop app runs on Windows only. Whether it is installed cannot be read
 * from a page; trying it and hearing back from the server is how we find out.
 */
function desktopAppMayBeInstalled() {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return window.__VOXLY_DESKTOP_V1__?.version !== 1 && /Windows/.test(navigator.userAgent);
}
