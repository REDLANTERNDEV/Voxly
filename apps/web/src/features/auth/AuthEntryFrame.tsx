import type { ReactNode } from "react";
import type { Translate } from "../../app/types.js";
import { AuthPageHeader } from "../../components/ui/Primitives.js";
import type { LanguageCode } from "../../lib/i18n.js";

export function AuthEntryFrame({
  children,
  language,
  t,
  onLanguageChange
}: {
  children: ReactNode;
  language: LanguageCode;
  t: Translate;
  onLanguageChange: (language: LanguageCode) => void;
}) {
  return (
    <main className="account-entry">
      <div className="account-entry-shell">
        <AuthPageHeader language={language} t={t} onLanguageChange={onLanguageChange} />
        <div className="account-entry-content">{children}</div>
      </div>
    </main>
  );
}
