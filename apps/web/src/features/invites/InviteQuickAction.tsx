import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Translate } from "../../app/types.js";
import { CloseIcon, UserPlusIcon } from "../../components/ui/Icons.js";
import { InviteComposer } from "./InviteComposer.js";

const popoverWidth = 300;

/**
 * Rail-level invite affordance for anyone holding Create invites (ADR-0038),
 * also opened by the server menu's Invite people. Mirrors the channel-create popover so
 * the rail keeps one interaction model for its inline forms.
 */
export function InviteQuickAction({
  serverId,
  serverName,
  publicUrl,
  openRequest = 0,
  onOpenRequestHandled,
  allowPermanent = false,
  t
}: {
  /** Manage invites: the composer may offer a link that never expires. */
  allowPermanent?: boolean;
  /** Bumped by the server menu's Invite people to open this popover from elsewhere. */
  openRequest?: number;
  /** Clears the request once it opened the popover, so a later mount never replays it. */
  onOpenRequestHandled?: () => void;
  serverId: string;
  serverName: string;
  publicUrl: string | null;
  t: Translate;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const label = t("invite.createFor", { server: serverName });

  const close = () => {
    setIsOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!popoverRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node))
        close();
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [isOpen]);

  // Closing on a server switch avoids leaving a popover that would mint a link
  // for the server the user just navigated away from.
  useEffect(() => setIsOpen(false), [serverId]);

  // A pending request opens it, even one made just before this mounted (the
  // server menu switches Server first); handling it clears it, so it is never
  // replayed by a later mount.
  useEffect(() => {
    if (!openRequest) return;
    onOpenRequestHandled?.();
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setPosition({
        top: rect.bottom + 8,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - popoverWidth - 8))
      });
    }
    setIsOpen(true);
  }, [openRequest, onOpenRequestHandled]);

  return (
    <>
      <button
        className="rail-invite-trigger"
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={isOpen}
        onClick={() => {
          const rect = triggerRef.current?.getBoundingClientRect();
          if (rect) {
            setPosition({
              top: rect.bottom + 8,
              left: Math.max(8, Math.min(rect.left, window.innerWidth - popoverWidth - 8))
            });
          }
          setIsOpen((current) => !current);
        }}
      >
        <UserPlusIcon />
        <span>{t("common.invite")}</span>
      </button>
      {isOpen
        ? createPortal(
            <div className="invite-popover" ref={popoverRef} role="dialog" aria-label={label} style={position}>
              <header className="invite-popover-head">
                <span className="label">{t("common.invite")}</span>
                <strong>{serverName}</strong>
                <button className="icon-btn" type="button" aria-label={t("common.cancel")} onClick={close}>
                  <CloseIcon />
                </button>
              </header>
              <InviteComposer
                serverId={serverId}
                publicUrl={publicUrl}
                idPrefix="railInvite"
                allowPermanent={allowPermanent}
                t={t}
              />
            </div>,
            document.body
          )
        : null}
    </>
  );
}
