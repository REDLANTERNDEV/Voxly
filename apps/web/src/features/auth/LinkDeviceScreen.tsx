import { AuthEntryFrame } from "./AuthEntryFrame.js";
import type { Translate } from "../../app/types.js";
import { LinkCodeClaim } from "./LinkCodeClaim.js";
import type { LanguageCode } from "../../lib/i18n.js";
import { DesktopBrowserSignIn } from "./DesktopBrowserSignIn.js";

/**
 * The arriving Device's half of linking: type the code, then wait to be let in.
 *
 * The wait is the feature. This screen cannot sign anybody in on its own — it
 * holds a claim token and polls, and the answer stays `pending` until a person
 * approves on the Device that minted the code. Somebody who read the code off a
 * screen share reaches exactly this screen and gets no further (ADR-0014).
 */
export function LinkDeviceScreen({
  language,
  t,
  onLanguageChange,
  onLinked,
  turnstileSiteKey
}: {
  language: LanguageCode;
  t: Translate;
  onLanguageChange: (language: LanguageCode) => void;
  onLinked: () => void;
  /** The operator's challenge, when they configured one. */
  turnstileSiteKey: string | null;
}) {
  const desktop = window.__VOXLY_DESKTOP_V1__?.version === 1;
  const codeSurface = <LinkCodeClaim t={t} onLinked={onLinked} turnstileSiteKey={turnstileSiteKey} />;
  return (
    <AuthEntryFrame language={language} t={t} onLanguageChange={onLanguageChange}>
      {desktop ? <DesktopBrowserSignIn t={t} onLinked={onLinked} /> : null}
      {desktop ? (
        <details className="desktop-link-fallback">
          <summary>{t("desktopSignIn.useCode")}</summary>
          {codeSurface}
        </details>
      ) : (
        codeSurface
      )}
    </AuthEntryFrame>
  );
}
