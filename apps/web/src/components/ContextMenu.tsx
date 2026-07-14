import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ContextMenuDescriptor } from "../lib/contextMenu.js";

export function ContextMenu({
  descriptor,
  label,
  onClose,
  children
}: {
  descriptor: ContextMenuDescriptor;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled])")?.focus();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClose();
      window.setTimeout(() => descriptor.trigger?.focus(), 0);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [descriptor, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu sidebar-context-menu"
      role="dialog"
      aria-label={label}
      style={{ left: descriptor.position.x, top: descriptor.position.y }}
    >
      {children}
    </div>,
    document.body
  );
}
