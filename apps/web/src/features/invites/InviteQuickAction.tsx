import { useEffect,useRef,useState } from "react";
import { createPortal } from "react-dom";
import type { Translate } from "../../app/types.js";
import { CloseIcon,UserPlusIcon } from "../../components/ui/Icons.js";
import { InviteComposer } from "./InviteComposer.js";

const popoverWidth = 300;

/**
 * Rail-level invite affordance for anyone allowed to create links — the owner
 * and members holding the invite grant. Mirrors the channel-create popover so
 * the rail keeps one interaction model for its inline forms.
 */
export function InviteQuickAction({ serverId, serverName, publicUrl, t }: {
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
      if (!popoverRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) close();
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
      </button>
      {isOpen ? createPortal(
        <div className="invite-popover" ref={popoverRef} role="dialog" aria-label={label} style={position}>
          <header className="invite-popover-head">
            <span className="label">{t("common.invite")}</span>
            <strong>{serverName}</strong>
            <button className="icon-btn" type="button" aria-label={t("common.cancel")} onClick={close}><CloseIcon /></button>
          </header>
          <p className="muted small">{t("invite.quickCopy")}</p>
          <InviteComposer serverId={serverId} publicUrl={publicUrl} idPrefix="railInvite" t={t} />
        </div>,
        document.body
      ) : null}
    </>
  );
}
