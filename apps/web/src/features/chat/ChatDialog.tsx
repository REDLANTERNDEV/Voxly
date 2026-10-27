import {
  FloatingFocusManager,
  FloatingPortal,
  useDismiss,
  useFloating,
  useInteractions,
  useRole
} from "@floating-ui/react";
import { useId, type ReactNode, type RefObject } from "react";
import type { Translate } from "../../app/types.js";
import { CloseIcon } from "../../components/ui/Icons.js";

/** Shared focus-contained surface for picker, reaction details, pins and identity. */
export function ChatDialog({
  title,
  onClose,
  children,
  t,
  initialFocus
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  t: Translate;
  /** Where focus lands on opening; the first control (the close button) otherwise. */
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  const id = useId();
  const { refs, context } = useFloating({
    open: true,
    onOpenChange: (open) => {
      if (!open) onClose();
    }
  });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getFloatingProps } = useInteractions([dismiss, role]);
  return (
    <FloatingPortal>
      <div
        className="chat-dialog-backdrop"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <FloatingFocusManager context={context} modal returnFocus initialFocus={initialFocus ?? 0}>
          <section ref={refs.setFloating} className="chat-dialog" {...getFloatingProps()} aria-labelledby={id}>
            <header>
              <h2 id={id}>{title}</h2>
              <button className="icon-btn" type="button" aria-label={t("common.close")} onClick={onClose}>
                <CloseIcon />
              </button>
            </header>
            {children}
          </section>
        </FloatingFocusManager>
      </div>
    </FloatingPortal>
  );
}
