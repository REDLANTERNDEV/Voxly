import type { PresenceChoiceRequest, PresenceChoiceState } from "@voxly/shared";
import { useEffect, useState, type RefObject } from "react";
import { initial } from "../../app/presentation.js";
import type { Translate } from "../../app/types.js";
import { copyText } from "../../lib/copyText.js";
import type { LanguageCode } from "../../lib/i18n.js";
import type { MemberPresenceState } from "../../lib/memberDirectory.js";
import type { TimeFormatPreference } from "../../lib/timeFormat.js";
import { ApplicationUpdateStatus } from "../ApplicationUpdateStatus.js";
import { MenuOverlayScope } from "../ContextMenu.js";
import { CopyIcon, GearIcon, LeaveIcon, ShieldIcon } from "../ui/Icons.js";
import { NavLink } from "../ui/Navigation.js";
import { AccountStatusMenu, PresenceDot } from "./AccountStatusMenu.js";

/**
 * The dock's account card, laid out like a profile card: who you are in this
 * Server, then what you can change about yourself, then the account's own
 * actions with signing out last.
 */
export function AccountCard(props: {
  menuRef: RefObject<HTMLDetailsElement | null>;
  nickname: string;
  mentionCode?: string;
  isOwner: boolean;
  selfState: MemberPresenceState;
  presenceChoice: PresenceChoiceState;
  language: LanguageCode;
  timeFormat: TimeFormatPreference;
  t: Translate;
  ownerPanelHref: string | null;
  onPresenceChoiceChange: (request: PresenceChoiceRequest) => void;
  onNavigate: (href: string) => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}) {
  const { menuRef, t } = props;
  const [overlays] = useState(() => new Set<HTMLElement>());
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const close = () => menuRef.current?.removeAttribute("open");

  // A <details> only closes from its own summary. A card that stays open after
  // the member clicks back into the chat reads as stuck, so close it on outside
  // input and Escape, counting the Status flyouts as part of it.
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const menu = menuRef.current;
      const target = event.target as Node;
      if (!menu?.open || menu.contains(target) || [...overlays].some((node) => node.contains(target))) return;
      menu.removeAttribute("open");
    };
    const escape = (event: KeyboardEvent) => {
      const menu = menuRef.current;
      if (event.key !== "Escape" || event.defaultPrevented || !menu?.open) return;
      menu.removeAttribute("open");
      menu.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [menuRef, overlays]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <MenuOverlayScope overlays={overlays}>
      <div className="account-card">
        <header className="account-card-head">
          <span className={`avatar account-card-avatar ${props.isOwner ? "owner" : ""}`} aria-hidden="true">
            {initial(props.nickname)}
            <PresenceDot state={props.selfState} />
          </span>
          <div className="account-card-identity">
            <strong>{props.nickname}</strong>
            <span className="account-card-meta">
              {props.mentionCode ? <span className="mono">#{props.mentionCode}</span> : null}
              {props.isOwner ? <span className="account-card-badge">{t("common.owner")}</span> : null}
            </span>
          </div>
        </header>
        <div className="account-card-section">
          <AccountStatusMenu
            choice={props.presenceChoice}
            selfState={props.selfState}
            language={props.language}
            timeFormat={props.timeFormat}
            t={t}
            onChange={props.onPresenceChoiceChange}
            onDone={close}
          />
          <button
            className="account-card-row"
            type="button"
            onClick={() => {
              close();
              props.onOpenSettings();
            }}
          >
            <GearIcon />
            <span>{t("settings.open")}</span>
          </button>
          {props.ownerPanelHref ? (
            <NavLink
              className="account-card-row"
              href={props.ownerPanelHref}
              label={t("owner.panel")}
              onNavigate={(href) => {
                close();
                props.onNavigate(href);
              }}
            >
              <ShieldIcon />
              <span>{t("owner.panel")}</span>
            </NavLink>
          ) : null}
          <ApplicationUpdateStatus t={t} surface="account" onSelect={close} />
        </div>
        <div className="account-card-section">
          {props.mentionCode ? (
            <button
              className="account-card-row"
              type="button"
              onClick={() => {
                void copyText(`#${props.mentionCode}`).then((ok) => setCopied(ok ? "copied" : "failed"));
              }}
            >
              <CopyIcon />
              <span>{t("shell.copyMentionCode")}</span>
              <span className="account-card-note" role="status">
                {copied === "copied"
                  ? t("shell.mentionCodeCopied")
                  : copied === "failed"
                    ? t("shell.mentionCodeCopyFailed")
                    : ""}
              </span>
            </button>
          ) : null}
          <button
            className="account-card-row is-danger"
            type="button"
            onClick={() => {
              close();
              props.onLogout();
            }}
          >
            <LeaveIcon />
            <span>{t("common.logout")}</span>
          </button>
        </div>
      </div>
    </MenuOverlayScope>
  );
}
