import type { ReactNode } from "react";
import { useEffect,useState } from "react";
import { initial,themeLabel } from "../../app/presentation.js";
import type { ThemeChoice,Translate } from "../../app/types.js";
import { ChatIcon,VolumeIcon } from "../../components/ui/Icons.js";
import { languageLabel,type LanguageCode } from "../../lib/i18n.js";
import { BrandLockup } from "./Navigation.js";
export function RoomHeader({ title, subtitle, actionLabel, onAction }: { title: string; subtitle: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <header className="room-header">
      <div className="room-title"><strong>{title}</strong><span className="muted small">{subtitle}</span></div>
      <div className="room-actions">
        {actionLabel && onAction ? <button className="btn btn-ghost" type="button" onClick={onAction}><ChatIcon /><span>{actionLabel}</span></button> : null}
      </div>
    </header>
  );
}


export function PreferencesCard({
  language,
  theme,
  t,
  onLanguageChange,
  onThemeChange
}: {
  language: LanguageCode;
  theme: ThemeChoice;
  t: Translate;
  onLanguageChange: (language: LanguageCode) => void;
  onThemeChange: (theme: ThemeChoice) => void;
}) {
  return (
    <section className="theme-card">
      {/* The heading names the setting and nothing else. Which of the three
          is in force is what the pressed segment below already says — in the
          same words, six pixels away — and `aria-pressed` says it to a screen
          reader, so a second copy up here was one more thing to read for a
          question the control had already answered. */}
      <div className="theme-card-head"><span className="label">{t("common.appearance")}</span></div>
      <div className="theme-options" role="group" aria-label={t("common.appearance")}>
        {(["auto", "light", "dark"] as const).map((option) => (
          <button className="theme-option" type="button" key={option} aria-pressed={theme === option} onClick={() => onThemeChange(option)}>{themeLabel(option, t)}</button>
        ))}
      </div>
      <LanguageSwitch language={language} t={t} onLanguageChange={onLanguageChange} />
    </section>
  );
}

export function LanguageSwitch({ language, t, onLanguageChange }: { language: LanguageCode; t: Translate; onLanguageChange: (language: LanguageCode) => void }) {
  return (
    <div className="language-switch">
      <div className="theme-card-head"><span className="label">{t("common.language")}</span></div>
      <div className="theme-options" role="group" aria-label={t("common.language")}>
        {(["en", "tr"] as const).map((option) => (
          <button className="theme-option" type="button" key={option} aria-pressed={language === option} onClick={() => onLanguageChange(option)}>{languageLabel(option)}</button>
        ))}
      </div>
    </div>
  );
}

/**
 * One dock control, and the two different questions it has to answer at once.
 *
 * `active` is whether the toggle is pressed, and it is what `aria-pressed`
 * says. It is *not* a judgement about the member: it means "the microphone is
 * live" on one control and "this member cannot hear" on the next, because
 * Deafen is a control you turn **on** in order to switch something **off**.
 * Deriving the whole appearance from it put a silenced member in the colour of
 * a healthy one — a self-muted microphone rendered exactly like a working
 * headset, and being deafened rendered exactly like a live microphone.
 *
 * `silenced` is the second question and the one a member glancing at the dock
 * is actually asking: can I be heard, and can I hear. It is deliberately
 * separate rather than derived, because no expression over `active` is right
 * for both controls — and separate from the owner-enforced `danger` tone,
 * because "you did this and can undo it" and "somebody did this to you" are
 * different sentences that must not look alike.
 */
export function ControlButton({ label, active, tone, enabled, silenced = false, onClick, children }: { label: string; active: boolean; tone: "neutral" | "danger"; enabled: boolean; silenced?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button className={`icon-btn control-icon ${active ? "is-active" : "is-off"} ${silenced ? "is-self-off" : ""} ${tone === "danger" ? "is-danger-state" : ""}`} type="button" aria-pressed={active} aria-label={label} title={label} disabled={!enabled} onClick={onClick}>
      {children}
    </button>
  );
}

export function Toast({ message }: { message: string }) {
  const [visibleMessage, setVisibleMessage] = useState("");

  useEffect(() => {
    if (!message) return;
    setVisibleMessage(message);
    const timeout = window.setTimeout(() => setVisibleMessage(""), 4200);
    return () => window.clearTimeout(timeout);
  }, [message]);

  return visibleMessage ? <div className="toast toast-danger" role="alert">{visibleMessage}</div> : null;
}


export function VolumeControl({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="volume-control">
      <span className="volume-control-label"><VolumeIcon /><span>{label}</span><strong>{value}%</strong></span>
      <input
        aria-label={label}
        type="range"
        min="0"
        max="200"
        step="1"
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}


export function StatusPill({ tone, children }: { tone: "live" | "online" | "warn" | "danger"; children: ReactNode }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

export function MemberRow({ user, detail, owner }: { user: string; detail: string; owner?: boolean }) {
  return (
    <span className="member-row">
      <span className={`avatar ${owner ? "owner" : ""}`}>{initial(user)}</span>
      <span className="member-copy"><strong>{user}</strong><span>{detail}</span></span>
    </span>
  );
}


export function EmptyState({ title, copy }: { title: string; copy: string }) {
  return <div className="empty-state"><h3>{title}</h3><p className="muted">{copy}</p></div>;
}

export function FatalState({ t }: { t: Translate }) {
  return <main className="invite-shell"><section className="invite-card"><BrandLockup /><div className="invite-status is-danger"><strong>{t("system.couldNotStart")}</strong><span className="muted small">{t("system.checkBackend")}</span></div></section></main>;
}
