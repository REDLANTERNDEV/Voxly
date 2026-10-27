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

type StatusMenuProps = {
  choice: PresenceChoiceState;
  selfState: MemberPresenceState;
  language: LanguageCode;
  timeFormat: TimeFormatPreference;
  t: Translate;
  onChange: (request: PresenceChoiceRequest) => void;
  onDone: () => void;
};

/**
 * The account card's Status row: one line saying what the member picked, and
 * until when, opening a flyout of all four. Like Discord's, it reads as the
 * current Status rather than as a list of choices.
 */
export function AccountStatusMenu(props: StatusMenuProps) {
  const { choice, selfState, language, timeFormat, t } = props;
  const until = choice.until
    ? new Intl.DateTimeFormat(language, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        ...timeFormatOptions(timeFormat)
      }).format(new Date(choice.until))
    : null;
  return (
    <MenuSubmenu
      className="account-card-row account-status-row"
      label={t(`presence.${selfState}` as const)}
      description={until ? t("presence.until", { time: until }) : undefined}
      panelLabel={t("presence.statusMenu")}
      icon={<PresenceDot state={selfState} />}
    >
      <AccountStatusOptions {...props} />
    </MenuSubmenu>
  );
}

/**
 * The flyout's rows. Online is a single choice; every other Status opens a
 * submenu of how long it should last, so a member who steps away for lunch
 * does not have to remember to come back.
 */
export function AccountStatusOptions({ choice, t, onChange, onDone }: StatusMenuProps) {
  const choose = (status: PresenceChoice, minutes: PresenceDurationMinutes | null) => {
    onChange(presenceChoiceRequest(status, minutes));
    onDone();
  };
  return (
    <>
      {presenceChoices.map((status) => {
        const label = t(`presence.${status}` as const);
        const description = status === "dnd" || status === "invisible" ? t(descriptionKeys[status]) : undefined;
        if (status === "online") {
          return (
            <button
              key={status}
              type="button"
              role="menuitemradio"
              aria-checked={choice.status === status}
              className="account-status-option"
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
            className={`account-status-option${choice.status === status ? " is-current" : ""}`}
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
    </>
  );
}
