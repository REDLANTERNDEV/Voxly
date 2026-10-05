import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, shift, size, useFloating } from "@floating-ui/react";
import type { ContextMenuDescriptor } from "../lib/contextMenu.js";

const MenuOverlays = createContext<Set<HTMLElement> | null>(null);
export function useMenuOverlays() { return useContext(MenuOverlays); }

export function ContextMenu({ descriptor, label, onClose, children }: {
  descriptor: ContextMenuDescriptor;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const overlays = useMemo(() => new Set<HTMLElement>(), [descriptor]);
  const { refs, floatingStyles, isPositioned } = useFloating({
    placement: "bottom-start", strategy: "fixed", whileElementsMounted: autoUpdate,
    middleware: [shift({ padding: 8, crossAxis: true }), size({ padding: 8, apply({ elements }) {
      Object.assign(elements.floating.style, { maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100dvh - 16px)" });
    } })]
  });
  const setMenuRef = useCallback((node: HTMLDivElement | null) => { menuRef.current = node; refs.setFloating(node); }, [refs.setFloating]);
  useLayoutEffect(() => {
    const point = descriptor.anchor ?? descriptor.position;
    refs.setPositionReference({ getBoundingClientRect: () => new DOMRect(point.x, point.y, 0, 0) });
  }, [descriptor, refs.setPositionReference]);
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled])")?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && ![...overlays].some(node => node.contains(target))) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      onClose();
      window.setTimeout(() => descriptor.trigger?.focus(), 0);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [descriptor, onClose, overlays, isPositioned]);
  return createPortal(<MenuOverlays.Provider value={overlays}>
    <div ref={setMenuRef} className="context-menu sidebar-context-menu"
      role="dialog" aria-label={label} style={{ ...floatingStyles, visibility: isPositioned ? undefined : "hidden" }}>{children}</div>
  </MenuOverlays.Provider>, document.fullscreenElement ?? document.body);
}
