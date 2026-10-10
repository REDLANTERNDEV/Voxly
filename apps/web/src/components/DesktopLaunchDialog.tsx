import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Native dialog keeps browser approval above Settings and contains keyboard focus. */
export function DesktopLaunchDialog({
  title,
  onCancel,
  children
}: {
  title: string;
  onCancel: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      returnFocus?.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className="desktop-launch-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>,
    document.body
  );
}
