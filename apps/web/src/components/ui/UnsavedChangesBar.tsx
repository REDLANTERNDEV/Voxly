import { useCallback, useRef, useState, type RefObject } from "react";
import type { Translate } from "../../app/types.js";

/**
 * Edits are drafts until the member saves them, and a surface holding drafts
 * refuses to be left. Every way out goes through the surface's own guard, which
 * calls `alertUnsaved` instead of leaving; the bar then turns red and says why
 * until the drafts are saved or reset.
 */
export function useUnsavedChanges() {
  const barRef = useRef<HTMLDivElement>(null);
  const [blocked, setBlocked] = useState(false);

  const alertUnsaved = useCallback(() => {
    setBlocked(true);
    const bar = barRef.current;
    if (!bar?.animate) return;
    const style = getComputedStyle(bar);
    // The theme's own tokens, read from the bar, so the blink matches both themes.
    const rest = { backgroundColor: style.backgroundColor, color: style.color };
    const alarm = {
      backgroundColor: style.getPropertyValue("--danger").trim(),
      color: style.getPropertyValue("--danger-on").trim()
    };
    // A refused leave blinks the bar red; the shake is motion and goes with a
    // reduced-motion preference, the colour stays.
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    bar.animate(
      reducedMotion
        ? [rest, alarm, rest, alarm, rest]
        : [
            { ...rest, transform: "translateX(0)" },
            { ...alarm, transform: "translateX(-8px)" },
            { ...alarm, transform: "translateX(8px)" },
            { ...alarm, transform: "translateX(-6px)" },
            { ...alarm, transform: "translateX(4px)" },
            { ...rest, transform: "translateX(0)" }
          ],
      { duration: reducedMotion ? 900 : 560, easing: "ease-out" }
    );
  }, []);

  return { barRef, blocked, setBlocked, alertUnsaved };
}

/** The Save/Reset bar, shown only while something is unsaved. */
export function UnsavedChangesBar({
  barRef,
  dirty,
  blocked,
  blockedMessage,
  saving,
  canSave,
  t,
  className = "",
  onReset,
  onSave
}: {
  barRef: RefObject<HTMLDivElement | null>;
  dirty: boolean;
  blocked: boolean;
  /** Why leaving was refused, in the surface's own words. */
  blockedMessage: string;
  saving: boolean;
  canSave: boolean;
  t: Translate;
  className?: string;
  onReset: () => void;
  onSave: () => void;
}) {
  const message = blocked ? blockedMessage : t("unsaved.message");
  return (
    <>
      <p className="sr-only" role="status">
        {dirty ? message : ""}
      </p>
      <div ref={barRef} className={`unsaved-bar ${className} ${blocked ? "is-blocked" : ""}`} hidden={!dirty}>
        <p>{message}</p>
        <div className="unsaved-bar-actions">
          <button className="btn btn-ghost" type="button" disabled={saving} onClick={onReset}>
            {t("unsaved.reset")}
          </button>
          <button className="btn btn-primary" type="button" disabled={saving || !canSave} onClick={onSave}>
            {saving ? t("unsaved.saving") : t("unsaved.save")}
          </button>
        </div>
      </div>
    </>
  );
}
