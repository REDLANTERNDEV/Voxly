import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  autoUpdate,
  flip,
  shift,
  size,
  offset,
  safePolygon,
  useFloating,
  useHover,
  useClick,
  useRole,
  useListNavigation,
  useInteractions
} from "@floating-ui/react";
import { useMenuOverlays } from "./ContextMenu.js";

export interface SubmenuItem {
  id: string;
  label: string;
  disabled?: boolean;
}
export function MenuSubmenu({
  label,
  items,
  onSelect
}: {
  label: string;
  items: readonly SubmenuItem[];
  onSelect(id: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const keyboardOpenRef = useRef(false);
  const listRef = useRef<Array<HTMLElement | null>>([]);
  const overlays = useMenuOverlays();
  const { refs, floatingStyles, context, placement, isPositioned } = useFloating({
    open,
    onOpenChange: (next, event) => {
      keyboardOpenRef.current = next && event?.type === "keydown";
      setOpen(next);
    },
    placement: "right-start",
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(8),
      flip({ padding: 8, fallbackPlacements: ["left-start", "bottom-start", "top-start"] }),
      shift({ padding: 8, crossAxis: true }),
      size({
        padding: 8,
        apply({ availableWidth, availableHeight, elements }) {
          Object.assign(elements.floating.style, {
            maxWidth: `${Math.max(0, availableWidth)}px`,
            maxHeight: `${Math.max(0, Math.min(260, availableHeight))}px`
          });
        }
      })
    ]
  });
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    useHover(context, { handleClose: safePolygon({ blockPointerEvents: false }), mouseOnly: true }),
    useClick(context),
    useRole(context, { role: "menu" }),
    useListNavigation(context, { listRef, activeIndex, onNavigate: setActiveIndex, nested: true, loop: true })
  ]);
  useLayoutEffect(() => {
    if (open && isPositioned && keyboardOpenRef.current) {
      const index = activeIndex ?? items.findIndex((item) => !item.disabled);
      if (index >= 0) {
        if (activeIndex === null) setActiveIndex(index);
        listRef.current[index]?.focus();
      }
    }
  }, [open, isPositioned, activeIndex, items]);
  useEffect(() => {
    const node = refs.floating.current;
    if (!open || !node || !overlays) return;
    overlays.add(node);
    return () => {
      overlays.delete(node);
    };
  }, [open, overlays, refs.floating]);
  const closeOnKey = (event: React.KeyboardEvent) => {
    if (open && (event.key === "Escape" || event.key === "ArrowLeft")) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      (refs.domReference.current as HTMLElement | null)?.focus();
    }
  };
  return (
    <div className="menu-submenu" onKeyDown={closeOnKey}>
      <button ref={refs.setReference} type="button" className="menu-submenu-trigger" {...getReferenceProps()}>
        <span>{label}</span>
        <span className="menu-submenu-caret" aria-hidden="true">
          {open && placement.startsWith("left") ? "‹" : "›"}
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={refs.setFloating}
              className="context-menu menu-submenu-panel"
              style={{ ...floatingStyles, visibility: isPositioned ? undefined : "hidden" }}
              aria-label={label}
              {...getFloatingProps({ onKeyDown: closeOnKey })}
            >
              {items.map((item, index) => (
                <button
                  key={item.id}
                  ref={(node) => {
                    listRef.current[index] = node;
                  }}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  tabIndex={activeIndex === index ? 0 : -1}
                  {...getItemProps({
                    onClick: () => {
                      setOpen(false);
                      onSelect(item.id);
                    }
                  })}
                >
                  {item.label}
                </button>
              ))}
            </div>,
            document.fullscreenElement ?? document.body
          )
        : null}
    </div>
  );
}
