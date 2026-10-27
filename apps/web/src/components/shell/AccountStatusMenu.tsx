import type {
  PresenceChoice,
  PresenceChoiceRequest,
  PresenceChoiceState,
  PresenceDurationMinutes
} from "@voxly/shared";
import type { Translate } from "../../app/types.js";
import type { LanguageCode } from "../../lib/i18n.js";
import type { MemberPresenceState } from "../../lib/memberDirectory.js";
import {
  presenceChoiceRequest,
  presenceChoices,
  presenceDurationKey,
  presenceDurations
} from "../../lib/presenceChoice.js";
import { timeFormatOptions, type TimeFormatPreference } from "../../lib/timeFormat.js";
import { MenuSubmenu } from "../MenuSubmenu.js";

const descriptionKeys = {
  dnd: "presence.dndDescription",
  invisible: "presence.invisibleDescription"
} as const;

export function PresenceDot({ state, label }: { state: MemberPresenceState; label?: string }) {
  return label ? (
    <span className={`presence-dot is-${state}`} role="img" aria-label={label} />
  ) : (
    <span className={`presence-dot is-${state}`} aria-hidden="true" />
  );
}

/**
 * The Status rows in the dock's account menu. Online is a single choice; every
 * other Status opens a submenu of how long it should last, so a member who
 * steps away for lunch does not have to remember to come back.
 */
export function AccountStatusMenu({
  choice,
  selfState,
  language,
  timeFormat,
  t,
  onChange,
  onDone
}: {
  choice: PresenceChoiceState;
  selfState: MemberPresenceState;
  language: LanguageCode;
  timeFormat: TimeFormatPreference;
  t: Translate;
  onChange: (request: PresenceChoiceRequest) => void;
  onDone: () => void;
}) {
  const choose = (status: PresenceChoice, minutes: PresenceDurationMinutes | null) => {
    onChange(presenceChoiceRequest(status, minutes));
    onDone();
  };
  const until = choice.until
    ? new Intl.DateTimeFormat(language, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        ...timeFormatOptions(timeFormat)
      }).format(new Date(choice.until))
    : null;
  return (
    <div className="account-status" role="group" aria-label={t("presence.statusMenu")}>
      <p className="account-status-current">
        <PresenceDot state={selfState} />
        <span>{t("presence.setStatus", { status: t(`presence.${selfState}` as const) })}</span>
        {until ? <small>{t("presence.until", { time: until })}</small> : null}
      </p>
      {presenceChoices.map((status) => {
        const label = t(`presence.${status}` as const);
        const description = status === "dnd" || status === "invisible" ? t(descriptionKeys[status]) : undefined;
        if (status === "online") {
          return (
            <button
              key={status}
              type="button"
              className="btn btn-ghost account-status-option"
              aria-pressed={choice.status === status}
              onClick={() => choose(status, null)}
            >
              <PresenceDot state="online" />
              <span>{label}</span>
            </button>
          );
        }
        return (
          <MenuSubmenu
            key={status}
            className={`btn btn-ghost account-status-option${choice.status === status ? " is-current" : ""}`}
            label={label}
            description={description}
            panelLabel={t("presence.durationMenu", { status: label })}
            icon={<PresenceDot state={status} />}
            items={presenceDurations.map((minutes) => ({
              id: String(minutes),
              label: t(presenceDurationKey(minutes))
            }))}
            onSelect={(id) => choose(status, id === "null" ? null : (Number(id) as PresenceDurationMinutes))}
          />
        );
      })}
    </div>
  );
}
