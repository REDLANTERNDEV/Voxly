import { AuthEntryFrame } from "./AuthEntryFrame.js";
import type { Translate } from "../../app/types.js";
import { RecoveryRedeem } from "./RecoveryRedeem.js";
import type { LanguageCode } from "../../lib/i18n.js";

/**
 * Getting back in with no Device left.
 *
 * The cost is stated **before** the code is entered, not after. A member who
 * reached for this when they meant to link a Device is about to sign themselves
 * out of everything, and finding that out afterwards is not a warning — it is a
 * surprise. See ADR-0014.
 *
 * On success the member lands straight in the app. No replacement code is
 * pushed on them here: they have just recovered, which is the least careful
 * moment to hand somebody a new secret to look after, and the code they used is
 * spent either way. The settings card then says the account has none, so making
 * a new one is a decision rather than a step to click past.
 */
export function RecoverScreen({
  language,
  t,
  onLanguageChange,
  onRecovered,
  turnstileSiteKey
}: {
  language: LanguageCode;
  t: Translate;
  onLanguageChange: (language: LanguageCode) => void;
  onRecovered: () => void;
  /** The operator's challenge, when they configured one. */
  turnstileSiteKey: string | null;
}) {
  return (
    <AuthEntryFrame language={language} t={t} onLanguageChange={onLanguageChange}>
      <RecoveryRedeem t={t} onRecovered={onRecovered} turnstileSiteKey={turnstileSiteKey} />
    </AuthEntryFrame>
  );
}
